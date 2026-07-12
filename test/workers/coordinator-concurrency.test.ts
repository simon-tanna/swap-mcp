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
  microtaskDrain,
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

    // STRUCTURAL ordering guard: each swap pushes a tagged event SYNCHRONOUSLY at
    // the two edges of its engine window — "<tag>-open" at the start of its
    // sendTransaction, "<tag>-close" at the end of its waitForReceipt. Because
    // pushes are synchronous, the array captures the true happens-before order of
    // the hooks with no timer ties and no `>=` comparison. Under the mutex the
    // only legal sequence is A fully before B; any interleaving (B opening inside
    // A's still-open window) reorders the array and fails the exact-equality
    // assertion. To make the missing-mutex case DETERMINISTIC, each swap parks
    // across a wide microtask drain between open and close — without the mutex
    // swap B's chain provably runs its own sendTransaction during A's park.
    const sequence: string[] = [];

    // Distinct tx hashes per call so waitForReceipt can be tagged per-swap; the
    // send order assigns the tag, so the FIRST-launched call is "A".
    const hashes = [
      "0x1111111111111111111111111111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    ];
    const tagFor = new Map<string, string>();
    let sendCount = 0;

    await runInDurableObject(stub, async (instance: SwapCoordinator) => {
      const signer = fakeSigner({
        async sendTransaction() {
          const idx = sendCount++;
          const tag = idx === 0 ? "A" : "B";
          const hash = hashes[idx];
          tagFor.set(hash, tag);
          // Synchronous window-open marker: nothing has yielded yet this tick.
          sequence.push(`${tag}-open`);
          return hash;
        },
        async waitForReceipt(hash) {
          const tag = tagFor.get(hash)!;
          // Widen the interleaving window: without the mutex, the OTHER swap's
          // sendTransaction ("B-open") lands here, between this open and close.
          await microtaskDrain();
          sequence.push(`${tag}-close`);
          return { kind: "success", gasUsed: 21000n };
        },
      });
      instance.deps = makeDeps(signer);

      // Fire BOTH promises without awaiting the first — same live instance.
      const pA = instance.executeSwap(ethToUsdcInput());
      const pB = instance.executeSwap(ethToUsdcInput());
      await Promise.all([pA, pB]);
    });

    // The mutex admits EXACTLY this order: A's whole window, then B's whole
    // window. Without it, B-open interleaves before A-close and this fails.
    expect(sequence).toEqual(["A-open", "A-close", "B-open", "B-close"]);
  });

  test("no overlapping submit and nonce order preserved", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("nonce-order");
    const stub = env.SWAP_COORDINATOR.get(id);

    // NON-OVERLAP guard: a wallet must never submit tx N+1 while tx N is still
    // in flight (unconfirmed) — that is what would burn or collide a nonce. We
    // capture submit/confirm as SYNCHRONOUS tagged edges: "submit-k" pushed at
    // the top of the k-th sendTransaction, "confirm-k" pushed at the end of that
    // swap's waitForReceipt. A concurrent (unserialized) run interleaves the next
    // submit INSIDE the previous swap's in-flight window (before its confirm),
    // because each waitForReceipt parks across a wide microtask drain. Under the
    // mutex the drain cannot overlap: each swap's submit→confirm pair is atomic,
    // so the recorded edges are strictly [submit-0,confirm-0,submit-1,...]. The
    // recorded nonces are checked too, but the EDGE sequence is the real guard —
    // it fails deterministically the instant a submit lands inside an open flight.
    let nonce = 0;
    const recordedNonces: number[] = [];
    const flightEdges: string[] = [];
    const hashPrefix =
      "0xabc0000000000000000000000000000000000000000000000000000000000000";
    const nonceForHash = new Map<string, number>();
    let sendCount = 0;

    await runInDurableObject(stub, async (instance: SwapCoordinator) => {
      const signer = fakeSigner({
        async sendTransaction() {
          const assigned = nonce++;
          recordedNonces.push(assigned);
          // Synchronous submit edge for this in-flight window.
          flightEdges.push(`submit-${assigned}`);
          const n = sendCount++;
          const hash = hashPrefix.slice(0, -1) + String(n);
          nonceForHash.set(hash, assigned);
          return hash;
        },
        async waitForReceipt(hash) {
          const assigned = nonceForHash.get(hash)!;
          // Hold the flight OPEN across a wide window; without the mutex the next
          // swap's submit edge lands here, before this confirm edge.
          await microtaskDrain();
          flightEdges.push(`confirm-${assigned}`);
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
    // Each submit→confirm flight is atomic under the mutex: no submit lands inside
    // another swap's still-open flight window. Without the mutex a later submit
    // interleaves before the prior confirm and this exact-order assertion fails.
    expect(flightEdges).toEqual([
      "submit-0",
      "confirm-0",
      "submit-1",
      "confirm-1",
      "submit-2",
      "confirm-2",
    ]);
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
    let submittedId: string;
    try {
      const rows = await db.query.swaps.findMany({
        where: eq(swaps.txHash, parkedHash),
      });
      expect(rows).toHaveLength(1);
      submittedId = rows[0].id;
      const midRow = await outsideRepo.findById(submittedId);
      expect(midRow).toBeDefined();
      expect(midRow!.status).toBe("submitted");
      expect(midRow!.txHash).toBe(parkedHash);
      // The call has NOT resolved yet — the row is live-visible mid-flight.
      expect(settled).toBe(false);
    } finally {
      // Always release the parked receipt, even if an assertion above threw, so
      // the DO's inner executeSwap promise can never be left unresolved.
      release.resolve();
    }

    // Confirm the call resolves terminally now that the receipt is released.
    const result = await runPromise;
    expect(settled).toBe(true);
    expect(result.transactionId).toBe(submittedId);
    expect(result.status).toBe("confirmed");

    const finalRow = await outsideRepo.findById(submittedId);
    expect(finalRow!.status).toBe("confirmed");
  });
});
