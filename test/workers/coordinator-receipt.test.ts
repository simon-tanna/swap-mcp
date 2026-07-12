/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as schema from "../../src/db/schema";
import { swaps } from "../../src/db/schema";
import type { SwapCoordinator } from "../../src/coordinator/SwapCoordinator";
import { createTransactionsRepository } from "../../src/repository/transactions";
import {
  ethToUsdcInput,
  fakeSigner,
  makeDeps as makeDepsWithRepo,
  TX_HASH,
} from "./helpers/coordinatorFakes";
import type { ViemSigner } from "../../src/engine/viemSigner";
import type { SwapServiceDeps } from "../../src/services/swapService";

const db = drizzle(env.DB, { schema });
const repo = createTransactionsRepository(db);

/** The rails default deadline (seconds); asserted as the receipt-wait bound. See src/services/rails.ts. */
const DEFAULT_DEADLINE_SECONDS = 1200;

/** Assemble injectable deps from fakes plus this file's REAL repository, so D1 is genuinely written. */
function makeDeps(signer: ViemSigner): SwapServiceDeps {
  return makeDepsWithRepo(signer, repo);
}

beforeEach(async () => {
  await db.delete(swaps);
});

describe("SwapCoordinator receipt disambiguation", () => {
  test("receipt timeout leaves the row submitted with txHash and returns result timed_out", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("receipt-timeout");
    const stub = env.SWAP_COORDINATOR.get(id);
    const params = ethToUsdcInput();

    const send = vi.fn(async () => TX_HASH);
    const signer = fakeSigner({
      sendTransaction: send,
      async waitForReceipt() {
        return { kind: "timeout" };
      },
    });

    const result = await runInDurableObject(
      stub,
      async (instance: SwapCoordinator) => {
        instance.deps = makeDeps(signer);
        return instance.executeSwap(params);
      },
    );

    // Broadcast happened exactly once; a timeout is an undetermined outcome, so
    // the row stays `submitted` with its hash — never downgraded to `failed`.
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("submitted");
    expect(result.result).toBe("timed_out");
    expect(result.txHash).toBe(TX_HASH);

    const row = await db.query.swaps.findFirst({
      where: eq(swaps.id, result.transactionId),
    });
    expect(row).toBeDefined();
    expect(row!.status).toBe("submitted");
    expect(row!.txHash).toBe(TX_HASH);
    expect(row!.errorCode).toBeNull();
    // No fifth status value ever appears: only the four lifecycle states exist.
    expect(["pending", "submitted", "confirmed", "failed"]).toContain(
      row!.status,
    );
  });

  test("revert writes failed with swap_failed keeping txHash", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("receipt-revert");
    const stub = env.SWAP_COORDINATOR.get(id);
    const params = ethToUsdcInput();

    const send = vi.fn(async () => TX_HASH);
    const signer = fakeSigner({
      sendTransaction: send,
      async waitForReceipt() {
        return { kind: "reverted" };
      },
    });

    const result = await runInDurableObject(
      stub,
      async (instance: SwapCoordinator) => {
        instance.deps = makeDeps(signer);
        return instance.executeSwap(params);
      },
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("swap_failed");
    expect(result.txHash).toBe(TX_HASH);

    // A genuine revert is the ONLY post-broadcast outcome that writes `failed`,
    // and unlike a pre-submit abort it retains the broadcast tx hash.
    const row = await db.query.swaps.findFirst({
      where: eq(swaps.id, result.transactionId),
    });
    expect(row).toBeDefined();
    expect(row!.status).toBe("failed");
    expect(row!.errorCode).toBe("swap_failed");
    expect(row!.txHash).toBe(TX_HASH);
  });

  test("a non-timeout throw (unknown) leaves the row submitted with result timed_out", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("receipt-unknown");
    const stub = env.SWAP_COORDINATOR.get(id);
    const params = ethToUsdcInput();

    const send = vi.fn(async () => TX_HASH);
    // `unknown` models an RPC error, a replacement tx, or receipt-not-found: the
    // swap may still have landed, so it MUST share the timeout mapping and never
    // be conflated with a genuine `reverted` receipt.
    const signer = fakeSigner({
      sendTransaction: send,
      async waitForReceipt() {
        return { kind: "unknown" };
      },
    });

    const result = await runInDurableObject(
      stub,
      async (instance: SwapCoordinator) => {
        instance.deps = makeDeps(signer);
        return instance.executeSwap(params);
      },
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("submitted");
    expect(result.result).toBe("timed_out");
    expect(result.txHash).toBe(TX_HASH);
    expect(result.errorCode).toBeUndefined();

    const row = await db.query.swaps.findFirst({
      where: eq(swaps.id, result.transactionId),
    });
    expect(row).toBeDefined();
    expect(row!.status).toBe("submitted");
    expect(row!.txHash).toBe(TX_HASH);
    // An unknown outcome is NEVER written failed/swap_failed.
    expect(row!.status).not.toBe("failed");
    expect(row!.errorCode).toBeNull();
  });

  test("timeout is never written as failed", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("receipt-timeout-not-failed");
    const stub = env.SWAP_COORDINATOR.get(id);
    const params = ethToUsdcInput();

    const send = vi.fn(async () => TX_HASH);
    const signer = fakeSigner({
      sendTransaction: send,
      async waitForReceipt() {
        return { kind: "timeout" };
      },
    });

    const result = await runInDurableObject(
      stub,
      async (instance: SwapCoordinator) => {
        instance.deps = makeDeps(signer);
        return instance.executeSwap(params);
      },
    );

    expect(result.status).toBe("submitted");

    // Re-read the row LATER (a second, independent query): nothing in the
    // post-broadcast path downgrades a timed-out row to `failed` after the fact.
    const later = await db.query.swaps.findFirst({
      where: eq(swaps.id, result.transactionId),
    });
    expect(later).toBeDefined();
    expect(later!.status).toBe("submitted");
    expect(later!.status).not.toBe("failed");
    expect(later!.errorCode).toBeNull();
    expect(later!.settledAt).toBeNull();
  });

  test("receipt wait is bounded by deadlineSeconds", async () => {
    // Default-deadline case: the fake captures the timeoutMs it is handed and we
    // assert it equals the rails default deadline (1200s) in milliseconds.
    let capturedDefault: number | undefined;
    const defaultSigner = fakeSigner({
      async waitForReceipt(_hash, timeoutMs) {
        capturedDefault = timeoutMs;
        return { kind: "success", gasUsed: 21000n };
      },
    });

    const idA = env.SWAP_COORDINATOR.idFromName("receipt-bound-default");
    const stubA = env.SWAP_COORDINATOR.get(idA);
    await runInDurableObject(stubA, async (instance: SwapCoordinator) => {
      instance.deps = makeDeps(defaultSigner);
      return instance.executeSwap(ethToUsdcInput());
    });

    expect(capturedDefault).toBe(DEFAULT_DEADLINE_SECONDS * 1000);
    expect(capturedDefault).toBe(1_200_000);

    // Explicit-deadline case: a caller-supplied deadlineSeconds flows through to
    // the wait bound verbatim (deadlineSeconds * 1000).
    let capturedExplicit: number | undefined;
    const explicitSigner = fakeSigner({
      async waitForReceipt(_hash, timeoutMs) {
        capturedExplicit = timeoutMs;
        return { kind: "success", gasUsed: 21000n };
      },
    });

    const explicitDeadline = 42;
    const idB = env.SWAP_COORDINATOR.idFromName("receipt-bound-explicit");
    const stubB = env.SWAP_COORDINATOR.get(idB);
    await runInDurableObject(stubB, async (instance: SwapCoordinator) => {
      instance.deps = makeDeps(explicitSigner);
      return instance.executeSwap({
        ...ethToUsdcInput(),
        deadlineSeconds: explicitDeadline,
      });
    });

    expect(capturedExplicit).toBe(explicitDeadline * 1000);
  });
});
