/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import * as schema from "../../src/db/schema";
import { swaps } from "../../src/db/schema";
import type { SwapCoordinator } from "../../src/coordinator/SwapCoordinator";
import { createTransactionsRepository } from "../../src/repository/transactions";
import {
  ethToUsdcInput,
  fakeSigner,
  makeDeps as makeDepsWithRepo,
} from "./helpers/coordinatorFakes";
import type { ViemSigner } from "../../src/engine/viemSigner";
import type { SwapServiceDeps } from "../../src/services/swapService";

const db = drizzle(env.DB, { schema });
const repo = createTransactionsRepository(db);

/** Assemble injectable deps from fakes plus this file's REAL repository, so D1 is genuinely written. */
function makeDeps(signer: ViemSigner): SwapServiceDeps {
  return makeDepsWithRepo(signer, repo);
}

/** A promise plus its resolver, so a test can park engine work and release it deterministically. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  await db.delete(swaps);
});

describe("SwapCoordinator concurrency", () => {
  test("two concurrent executeSwap calls are serialized by the in-DO promise chain", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("serialized");
    const stub = env.SWAP_COORDINATOR.get(id);

    // Each swap records the wall-clock window of its ENGINE work: sendTransaction
    // enter marks window-open, waitForReceipt exit marks window-close. With the
    // mutex, swap B's window must start strictly after swap A's window closes.
    type Window = { open?: number; close?: number };
    const windows: Window[] = [];

    // Distinct tx hashes per call so waitForReceipt can be gated per-swap.
    const hashes = [
      "0x1111111111111111111111111111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    ];
    let sendCount = 0;

    await runInDurableObject(stub, async (instance: SwapCoordinator) => {
      // One shared signer: sendTransaction opens the next window slot by call
      // order; waitForReceipt parks across several microtasks to WIDEN the span
      // during which a concurrent swap could interleave, then closes the window.
      // Without the mutex, swap B's sendTransaction (window open) fires while
      // swap A is still parked in waitForReceipt (before window A closes) — an
      // OVERLAP the disjoint-window assertion below catches.
      const signer = fakeSigner({
        async sendTransaction() {
          const idx = sendCount++;
          windows[idx] = { open: performance.now() };
          return hashes[idx];
        },
        async waitForReceipt(hash) {
          const idx = hashes.indexOf(hash);
          const gate = deferred();
          queueMicrotask(() => queueMicrotask(() => gate.resolve()));
          await gate.promise;
          windows[idx].close = performance.now();
          return { kind: "success", gasUsed: 21000n };
        },
      });
      instance.deps = makeDeps(signer);

      // Fire BOTH promises without awaiting the first — same live instance.
      const pA = instance.executeSwap(ethToUsdcInput());
      const pB = instance.executeSwap(ethToUsdcInput());
      await Promise.all([pA, pB]);
    });

    expect(windows).toHaveLength(2);
    expect(windows[0].open).toBeDefined();
    expect(windows[0].close).toBeDefined();
    expect(windows[1].open).toBeDefined();
    expect(windows[1].close).toBeDefined();

    // The invariant: swap B's window opens strictly after swap A's window closes.
    // Without the mutex the windows overlap (B opens before A closes) and this
    // fails; with the promise-chain mutex they are disjoint and ordered.
    expect(windows[1].open!).toBeGreaterThanOrEqual(windows[0].close!);
  });

  test("no overlapping submit and nonce order preserved", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("nonce-order");
    const stub = env.SWAP_COORDINATOR.get(id);

    // A shared nonce counter incremented on each submit; recorded per call. Under
    // serialization the recorded sequence is strictly increasing in call order.
    let nonce = 0;
    const recordedNonces: number[] = [];
    const hashPrefix =
      "0xabc0000000000000000000000000000000000000000000000000000000000000";
    let sendCount = 0;

    await runInDurableObject(stub, async (instance: SwapCoordinator) => {
      const signer = fakeSigner({
        async sendTransaction() {
          const assigned = nonce++;
          recordedNonces.push(assigned);
          // Unique hash per call so downstream waits are unambiguous.
          const n = sendCount++;
          return hashPrefix.slice(0, -1) + String(n);
        },
        async waitForReceipt() {
          const gate = deferred();
          queueMicrotask(() => gate.resolve());
          await gate.promise;
          return { kind: "success", gasUsed: 21000n };
        },
      });
      instance.deps = makeDeps(signer);

      const p1 = instance.executeSwap(ethToUsdcInput());
      const p2 = instance.executeSwap(ethToUsdcInput());
      const p3 = instance.executeSwap(ethToUsdcInput());
      await Promise.all([p1, p2, p3]);
    });

    expect(recordedNonces).toHaveLength(3);
    // Strictly increasing in call order — no interleaving reordered the submits.
    for (let i = 1; i < recordedNonces.length; i++) {
      expect(recordedNonces[i]).toBeGreaterThan(recordedNonces[i - 1]);
    }
    expect(recordedNonces).toEqual([0, 1, 2]);
  });

  test("get-path reads see submitted status before execute_swap returns", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("mid-swap-visible");
    const stub = env.SWAP_COORDINATOR.get(id);

    const parkedHash =
      "0xdeadbeef00000000000000000000000000000000000000000000000000000000";
    // Held until the outside reader has observed the mid-swap `submitted` row.
    const release = deferred();
    // Resolves once the swap is parked inside waitForReceipt (row is submitted).
    const parked = deferred();

    const signer = fakeSigner({
      async sendTransaction() {
        return parkedHash;
      },
      async waitForReceipt() {
        parked.resolve();
        await release.promise;
        return { kind: "success", gasUsed: 21000n };
      },
    });

    let settled = false;
    const runPromise = runInDurableObject(
      stub,
      async (instance: SwapCoordinator) => {
        instance.deps = makeDeps(signer);
        const result = await instance.executeSwap(ethToUsdcInput());
        settled = true;
        return result;
      },
    );

    // Wait until the swap has broadcast and parked inside waitForReceipt.
    await parked.promise;

    // From OUTSIDE the DO, read the single submitted row via the repository. The
    // eager markSubmitted must be live-visible cross-context before we release.
    const outsideRepo = createTransactionsRepository(
      drizzle(env.DB, { schema }),
    );
    const rows = await db.query.swaps.findMany({
      where: eq(swaps.txHash, parkedHash),
    });
    expect(rows).toHaveLength(1);
    const submittedId = rows[0].id;
    const midRow = await outsideRepo.findById(submittedId);
    expect(midRow).toBeDefined();
    expect(midRow!.status).toBe("submitted");
    expect(midRow!.txHash).toBe(parkedHash);
    // The call has NOT resolved yet — the row is live-visible mid-flight.
    expect(settled).toBe(false);

    // Release the parked receipt and confirm the call resolves terminally.
    release.resolve();
    const result = await runPromise;
    expect(settled).toBe(true);
    expect(result.transactionId).toBe(submittedId);
    expect(result.status).toBe("confirmed");

    const finalRow = await outsideRepo.findById(submittedId);
    expect(finalRow!.status).toBe("confirmed");
  });
});
