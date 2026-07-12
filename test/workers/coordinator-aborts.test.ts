/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as schema from "../../src/db/schema";
import { swaps } from "../../src/db/schema";
import type { SwapCoordinator } from "../../src/coordinator/SwapCoordinator";
import type { SwapDirection } from "../../src/engine/tradingApiClient";
import { createTransactionsRepository } from "../../src/repository/transactions";
import {
  ethToUsdcInput,
  fakeSigner,
  fakeTradingApi,
  makeDeps as makeDepsWithRepo,
  TX_HASH,
} from "./helpers/coordinatorFakes";
import type { ViemSigner } from "../../src/engine/viemSigner";
import type { TradingApiClient } from "../../src/engine/tradingApiClient";
import type { SwapServiceDeps } from "../../src/services/swapService";
import { checkApprovalNonNull } from "../fixtures/tradingApi";

const db = drizzle(env.DB, { schema });
const repo = createTransactionsRepository(db);

/** Assemble injectable deps from fakes plus this file's REAL repository, so D1 is genuinely written. */
function makeDeps(
  signer: ViemSigner,
  tradingApi: TradingApiClient = fakeTradingApi(),
): SwapServiceDeps {
  return makeDepsWithRepo(signer, repo, tradingApi);
}

beforeEach(async () => {
  await db.delete(swaps);
});

describe("SwapCoordinator abort dispositions", () => {
  test("caller drift floor aborts slippage_exceeded writing a failed row with no txHash", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("drift-abort");
    const stub = env.SWAP_COORDINATOR.get(id);
    // Quote outputs 999000000 USDC; a floor of 2000000000 is well above it, so
    // the drift rail must abort before any broadcast.
    const params = { ...ethToUsdcInput(), expectedAmountOut: "2000000000" };

    const send = vi.fn(async () => TX_HASH);
    const signer = fakeSigner({ sendTransaction: send });

    const result = await runInDurableObject(
      stub,
      async (instance: SwapCoordinator) => {
        instance.deps = makeDeps(signer);
        return instance.executeSwap(params);
      },
    );

    expect(result.status).toBe("failed");
    expect(result.result).toBe("ok");
    expect(result.errorCode).toBe("slippage_exceeded");
    expect(result.txHash).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(0);

    const row = await db.query.swaps.findFirst({
      where: eq(swaps.id, result.transactionId),
    });
    expect(row).toBeDefined();
    expect(row!.status).toBe("failed");
    expect(row!.errorCode).toBe("slippage_exceeded");
    expect(row!.txHash).toBeNull();
  });

  test("omitted floor proceeds without drift abort", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("no-floor");
    const stub = env.SWAP_COORDINATOR.get(id);
    // Same input but NO expectedAmountOut floor: the drift rail cannot fire, so
    // execution reaches buildSwap/submit and confirms.
    const params = ethToUsdcInput();

    const send = vi.fn(async () => TX_HASH);
    const signer = fakeSigner({ sendTransaction: send });

    const result = await runInDurableObject(
      stub,
      async (instance: SwapCoordinator) => {
        instance.deps = makeDeps(signer);
        return instance.executeSwap(params);
      },
    );

    expect(result.status).toBe("confirmed");
    expect(result.result).toBe("ok");
    expect(result.txHash).toBe(TX_HASH);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("USDC→ETH missing approval aborts approval_required without sending anything", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("approval-abort");
    const stub = env.SWAP_COORDINATOR.get(id);
    const params: {
      direction: SwapDirection;
      amountIn: string;
      userId: string;
    } = {
      direction: "USDC_TO_ETH",
      amountIn: "1000000000",
      userId: "user-1",
    };

    const send = vi.fn(async () => TX_HASH);
    const signer = fakeSigner({ sendTransaction: send });
    // checkApproval returns a non-null approval; the abort fires before buildSwap.
    const tradingApi = fakeTradingApi({
      async checkApproval() {
        return { approval: checkApprovalNonNull.approval };
      },
    });

    const result = await runInDurableObject(
      stub,
      async (instance: SwapCoordinator) => {
        instance.deps = makeDeps(signer, tradingApi);
        return instance.executeSwap(params);
      },
    );

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("approval_required");
    expect(result.txHash).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(0);

    const row = await db.query.swaps.findFirst({
      where: eq(swaps.id, result.transactionId),
    });
    expect(row).toBeDefined();
    expect(row!.status).toBe("failed");
    expect(row!.errorCode).toBe("approval_required");
    expect(row!.txHash).toBeNull();
  });

  test("gas-headroom shortfall aborts insufficient_balance", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("gas-shortfall");
    const stub = env.SWAP_COORDINATOR.get(id);
    const params = ethToUsdcInput();

    const send = vi.fn(async () => TX_HASH);
    // gasCost = gasLimit(250000) * maxFeePerGas(1) = 250000; headroom = 300000.
    // required = amountIn + 300000. Returning exactly amountIn makes balance
    // fall short of required by the headroom, forcing an insufficient_balance abort.
    const signer = fakeSigner({
      sendTransaction: send,
      async getNativeBalance() {
        return BigInt(params.amountIn);
      },
    });

    const result = await runInDurableObject(
      stub,
      async (instance: SwapCoordinator) => {
        instance.deps = makeDeps(signer);
        return instance.executeSwap(params);
      },
    );

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("insufficient_balance");
    expect(result.txHash).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(0);

    const row = await db.query.swaps.findFirst({
      where: eq(swaps.id, result.transactionId),
    });
    expect(row).toBeDefined();
    expect(row!.status).toBe("failed");
    expect(row!.errorCode).toBe("insufficient_balance");
    expect(row!.txHash).toBeNull();
  });

  test("rail abort leaves exactly one failed row (pending→failed)", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("one-row");
    const stub = env.SWAP_COORDINATOR.get(id);
    // Reuse the drift-abort setup: a caller floor above the quoted output.
    const params = { ...ethToUsdcInput(), expectedAmountOut: "2000000000" };

    const send = vi.fn(async () => TX_HASH);
    const signer = fakeSigner({ sendTransaction: send });

    const result = await runInDurableObject(
      stub,
      async (instance: SwapCoordinator) => {
        instance.deps = makeDeps(signer);
        return instance.executeSwap(params);
      },
    );

    expect(result.status).toBe("failed");

    const rows = await db.query.swaps.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.transactionId);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].txHash).toBeNull();
    expect(send).toHaveBeenCalledTimes(0);
  });

  test("a forced signer throw carrying secrets leaks nothing to D1 or logs", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("abort-leak-channels");
    const stub = env.SWAP_COORDINATOR.get(id);
    // No caller floor and native input, so execution reaches sendTransaction,
    // which throws a secret-bearing error on the pre-broadcast path.
    const params = ethToUsdcInput();

    const rpcUrl = env.ETH_RPC_URL;
    const privateKey = env.SWAP_PRIVATE_KEY;
    const secretMessage = `sendTransaction failed for ${rpcUrl} key=${privateKey}`;

    const logSpy = vi.spyOn(console, "log");
    const errorSpy = vi.spyOn(console, "error");

    const signer = fakeSigner({
      async sendTransaction() {
        throw new Error(secretMessage);
      },
    });

    let result;
    try {
      result = await runInDurableObject(
        stub,
        async (instance: SwapCoordinator) => {
          instance.deps = makeDeps(signer);
          return instance.executeSwap(params);
        },
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    // The throw is pre-broadcast, so the row closes `failed` carrying only an
    // allowlisted errorCode — never the raw secret-bearing text.
    expect(result.status).toBe("failed");
    const row = await db.query.swaps.findFirst({
      where: eq(swaps.id, result.transactionId),
    });
    expect(row).toBeDefined();
    for (const col of Object.values(row!)) {
      const s = String(col);
      expect(s).not.toContain(rpcUrl);
      expect(s).not.toContain(privateKey);
    }

    // Every captured coordinator log/error call's serialized output is secret-free.
    const captured = [...logSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of captured) {
      const serialized = call.map((a) => String(a)).join(" ");
      expect(serialized).not.toContain(rpcUrl);
      expect(serialized).not.toContain(privateKey);
    }
  });
});
