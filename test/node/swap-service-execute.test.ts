import { describe, expect, test, vi } from "vitest";
import { USDC_ADDRESS } from "../../src/engine/constants";
import type {
  ClassicQuoteResponse,
  QuoteInput,
  SwapTx,
  TradingApiClient,
} from "../../src/engine/tradingApiClient";
import type { ReceiptOutcome, ViemSigner } from "../../src/engine/viemSigner";
import type { TransactionsRepository } from "../../src/repository/transactions";
import { executeSwap } from "../../src/services/swapService";
import {
  checkApprovalNonNull,
  quoteClassic,
  quoteDutchV2,
  swapNested,
} from "../fixtures/tradingApi";

const SIGNER_ADDRESS = "0x9999999999999999999999999999999999999999";
const TX_HASH =
  "0x4ca7ee652d57678f26e887c149ab0735f41de37bcad58c9f6d3ed5824f15b74d";

/** 20 gwei — with the fixture gasLimit "250000" this yields a 5e15 wei gas cost. */
const MAX_FEE_PER_GAS = 20_000_000_000n;

/** 100 ETH: comfortably above any input + gas requirement in these tests. */
const GENEROUS_NATIVE = 10n ** 20n;

/** 1,000,000 USDC in base units — generous ERC-20 balance. */
const GENEROUS_ERC20 = 1_000_000_000_000n;

/** Decimals lock: 1 ETH input in 18-decimal base units. */
const ONE_ETH = "1000000000000000000";

/** Decimals lock: 1 USDC input in 6-decimal base units. */
const ONE_USDC = "1000000";

type Transition = { op: string } & Record<string, unknown>;

/** In-memory TransactionsRepository fake recording every lifecycle transition in order. */
function fakeRepo(opts: { throwOnMarkConfirmed?: boolean } = {}): {
  repo: TransactionsRepository;
  transitions: Transition[];
} {
  const transitions: Transition[] = [];
  let nextId = 1;
  const repo = {
    insertPending: vi.fn(async (row: Record<string, unknown>) => {
      const id = `tx-${nextId++}`;
      transitions.push({ op: "insertPending", id, row });
      return id;
    }),
    markSubmitted: vi.fn(async (id: string, txHash: string) => {
      transitions.push({ op: "markSubmitted", id, txHash });
    }),
    markConfirmed: vi.fn(
      async (id: string, r: { actualAmountOut: string; gasUsed: string }) => {
        if (opts.throwOnMarkConfirmed) {
          throw new Error("d1 write failed");
        }
        transitions.push({ op: "markConfirmed", id, ...r });
      },
    ),
    markFailed: vi.fn(
      async (id: string, errorCode: string, opts?: { txHash?: string }) => {
        transitions.push({
          op: "markFailed",
          id,
          errorCode,
          ...(opts?.txHash !== undefined && { txHash: opts.txHash }),
        });
      },
    ),
    findById: vi.fn(),
    list: vi.fn(),
  };
  return { repo: repo as unknown as TransactionsRepository, transitions };
}

/** Build the full fake deps surface; `events` records cross-port call order. */
function makeHarness(
  opts: {
    reQuote?: unknown;
    approval?: unknown;
    gasLimit?: string;
    nativeBalance?: bigint;
    erc20Balance?: bigint;
    receipt?: ReceiptOutcome;
    throwOnMarkConfirmed?: boolean;
  } = {},
) {
  const events: string[] = [];
  const quoteCalls: QuoteInput[] = [];
  const reQuote = (opts.reQuote ?? quoteClassic) as ClassicQuoteResponse;
  const swapTx: SwapTx = {
    ...swapNested.swap,
    gasLimit: opts.gasLimit ?? swapNested.swap.gasLimit,
  };

  const checkApproval = vi.fn(async () => {
    events.push("checkApproval");
    return { approval: opts.approval ?? null };
  });
  const getQuote = vi.fn(async (i: QuoteInput) => {
    events.push("getQuote");
    quoteCalls.push(i);
    return reQuote;
  });
  const buildSwap = vi.fn(async (_q: ClassicQuoteResponse) => {
    events.push("buildSwap");
    return swapTx;
  });
  const tradingApi: TradingApiClient = { checkApproval, getQuote, buildSwap };

  const sendTransaction = vi.fn(async () => {
    events.push("sendTransaction");
    return TX_HASH;
  });
  const signer: ViemSigner = {
    address: SIGNER_ADDRESS,
    getNativeBalance: vi.fn(async () => {
      events.push("getNativeBalance");
      return opts.nativeBalance ?? GENEROUS_NATIVE;
    }),
    getErc20Balance: vi.fn(async () => {
      events.push("getErc20Balance");
      return opts.erc20Balance ?? GENEROUS_ERC20;
    }),
    estimateMaxFeePerGas: vi.fn(async () => MAX_FEE_PER_GAS),
    sendTransaction,
    waitForReceipt: vi.fn(
      async (): Promise<ReceiptOutcome> =>
        opts.receipt ?? { kind: "success", gasUsed: 21000n },
    ),
  };

  const { repo, transitions } = fakeRepo({
    throwOnMarkConfirmed: opts.throwOnMarkConfirmed,
  });
  return {
    deps: { tradingApi, signer, repo },
    events,
    transitions,
    quoteCalls,
    spies: {
      checkApproval,
      getQuote,
      buildSwap,
      sendTransaction,
      markFailed: repo.markFailed as ReturnType<typeof vi.fn>,
      markSubmitted: repo.markSubmitted as ReturnType<typeof vi.fn>,
    },
    reQuote,
  };
}

const ETH_INPUT = {
  userId: "user-1",
  direction: "ETH_TO_USDC" as const,
  amountIn: ONE_ETH,
};

const USDC_INPUT = {
  userId: "user-1",
  direction: "USDC_TO_ETH" as const,
  amountIn: ONE_USDC,
};

describe("swapService.executeSwap", () => {
  test("happy path transitions pending→submitted→confirmed", async () => {
    const h = makeHarness();

    const result = await executeSwap(h.deps, ETH_INPUT);

    expect(h.transitions.map((t) => t.op)).toEqual([
      "insertPending",
      "markSubmitted",
      "markConfirmed",
    ]);
    // Decimals lock: 1 ETH persists as the 18-decimal base-unit string.
    expect(h.transitions[0].row).toMatchObject({
      userId: "user-1",
      direction: "ETH_TO_USDC",
      amountIn: ONE_ETH,
      quotedAmountOut: "999000000",
      slippageTolerancePct: "0.5",
      deadlineSeconds: 1200,
    });
    expect(h.transitions[1].txHash).toBe(TX_HASH);
    expect(h.transitions[2]).toMatchObject({
      op: "markConfirmed",
      actualAmountOut: "999000000",
      gasUsed: "21000",
    });
    expect(result).toMatchObject({
      status: "confirmed",
      result: "ok",
      txHash: TX_HASH,
      transactionId: h.transitions[0].id,
      actualAmountOut: "999000000",
      gasUsed: "21000",
    });
  });

  test("re-quote happens immediately before submission and is routing-asserted", async () => {
    // Fresh quote fetched inside executeSwap with the REAL signer as swapper.
    const happy = makeHarness();
    await executeSwap(happy.deps, ETH_INPUT);
    expect(happy.spies.getQuote).toHaveBeenCalledTimes(1);
    expect(happy.quoteCalls[0]).toEqual({
      direction: "ETH_TO_USDC",
      amount: ONE_ETH,
      swapper: SIGNER_ADDRESS,
      slippageTolerancePct: 0.5,
    });

    // A DUTCH_V2 re-quote fails the routing assertion and aborts with a failed row.
    const dutch = makeHarness({ reQuote: quoteDutchV2 });
    const result = await executeSwap(dutch.deps, ETH_INPUT);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("upstream_unavailable");
    expect(dutch.transitions.map((t) => t.op)).toEqual([
      "insertPending",
      "markFailed",
    ]);
    expect(dutch.transitions[1].errorCode).toBe("upstream_unavailable");
    expect(dutch.spies.sendTransaction).not.toHaveBeenCalled();
  });

  test("caller drift floor aborts with slippage_exceeded and no transaction", async () => {
    // Floor at 0.5% tolerance = 1100000000 - 5500000; fresh 999000000 is below it.
    const h = makeHarness();
    const result = await executeSwap(h.deps, {
      ...ETH_INPUT,
      expectedAmountOut: "1100000000",
    });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("slippage_exceeded");
    expect(result.txHash).toBeUndefined();
    expect(h.transitions.map((t) => t.op)).toEqual([
      "insertPending",
      "markFailed",
    ]);
    expect(h.transitions[1].errorCode).toBe("slippage_exceeded");
    expect(h.transitions[1]).not.toHaveProperty("txHash");
    expect(h.spies.sendTransaction).not.toHaveBeenCalled();
  });

  test("omitted floor never drift-aborts", async () => {
    // Heavily drifted fresh quote: output collapsed to 1 base unit.
    const drifted = {
      ...quoteClassic,
      quote: {
        ...quoteClassic.quote,
        output: { ...quoteClassic.quote.output, amount: "1" },
      },
    };
    const h = makeHarness({ reQuote: drifted });

    const result = await executeSwap(h.deps, ETH_INPUT);

    // No local floor: the flow proceeds to /swap and confirms.
    expect(result.status).toBe("confirmed");
    expect(h.spies.buildSwap).toHaveBeenCalledTimes(1);
    // The /swap-bound request is exactly the spread re-quote — the service
    // computes/carries no amountOutMinimum anywhere.
    const swapArg = h.spies.buildSwap.mock.calls[0][0];
    expect(swapArg).toBe(h.reQuote);
    expect(JSON.stringify(swapArg)).not.toContain("amountOutMinimum");
    expect(JSON.stringify(result)).not.toContain("amountOutMinimum");
  });

  test("USDC→ETH non-null approval aborts approval_required without any transaction", async () => {
    const h = makeHarness({ approval: checkApprovalNonNull.approval });

    const result = await executeSwap(h.deps, USDC_INPUT);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("approval_required");
    expect(h.spies.checkApproval).toHaveBeenCalledWith({
      token: USDC_ADDRESS,
      amount: ONE_USDC,
      walletAddress: SIGNER_ADDRESS,
    });
    expect(h.transitions.map((t) => t.op)).toEqual([
      "insertPending",
      "markFailed",
    ]);
    expect(h.transitions[1].errorCode).toBe("approval_required");
    // Neither a swap tx nor an approval tx is ever sent.
    expect(h.spies.sendTransaction).not.toHaveBeenCalled();
    expect(h.spies.buildSwap).not.toHaveBeenCalled();
  });

  test("ETH→USDC skips check_approval", async () => {
    const h = makeHarness();

    await executeSwap(h.deps, ETH_INPUT);

    expect(h.spies.checkApproval).not.toHaveBeenCalled();
  });

  test("balance/gas-headroom rail runs after buildSwap and consumes SwapTx.gasLimit", async () => {
    // Call order on the happy path: buildSwap → balance read → sendTransaction.
    const happy = makeHarness();
    await executeSwap(happy.deps, ETH_INPUT);
    const build = happy.events.indexOf("buildSwap");
    const balance = happy.events.indexOf("getNativeBalance");
    const send = happy.events.indexOf("sendTransaction");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(build).toBeLessThan(balance);
    expect(balance).toBeLessThan(send);

    // Shortfall is computed from the gasLimit buildSwap returned: with a balance
    // of amountIn + 1.1e16 wei, gasLimit "500000" (gas cost 1e16 + headroom)
    // fails while gasLimit "250000" (gas cost 5e15 + headroom) passes.
    const balanceWei = BigInt(ONE_ETH) + 11_000_000_000_000_000n;
    const tight = makeHarness({
      gasLimit: "500000",
      nativeBalance: balanceWei,
    });
    const tightResult = await executeSwap(tight.deps, ETH_INPUT);
    expect(tightResult.status).toBe("failed");
    expect(tightResult.errorCode).toBe("insufficient_balance");
    // The rail fires before sign/submit.
    expect(tight.spies.sendTransaction).not.toHaveBeenCalled();

    const roomy = makeHarness({
      gasLimit: "250000",
      nativeBalance: balanceWei,
    });
    const roomyResult = await executeSwap(roomy.deps, ETH_INPUT);
    expect(roomyResult.status).toBe("confirmed");
  });

  test("ETH→USDC balance rail requires amountIn plus gas headroom", async () => {
    // nativeBalance == amountIn exactly leaves nothing for gas: must fail.
    const exact = makeHarness({ nativeBalance: BigInt(ONE_ETH) });
    const exactResult = await executeSwap(exact.deps, ETH_INPUT);
    expect(exactResult.status).toBe("failed");
    expect(exactResult.errorCode).toBe("insufficient_balance");
    expect(exact.spies.sendTransaction).not.toHaveBeenCalled();

    const generous = makeHarness({ nativeBalance: GENEROUS_NATIVE });
    const generousResult = await executeSwap(generous.deps, ETH_INPUT);
    expect(generousResult.status).toBe("confirmed");
  });

  test("USDC→ETH balance rail checks erc20 input and native gas separately", async () => {
    // Decimals lock: 1 USDC input compares against the 6-decimal base-unit string.
    const shortErc20 = makeHarness({ erc20Balance: 999_999n });
    const erc20Result = await executeSwap(shortErc20.deps, USDC_INPUT);
    expect(erc20Result.status).toBe("failed");
    expect(erc20Result.errorCode).toBe("insufficient_balance");
    expect(shortErc20.deps.signer.getErc20Balance).toHaveBeenCalledWith(
      USDC_ADDRESS,
      SIGNER_ADDRESS,
    );

    // Sufficient USDC but native below gasLimit × maxFeePerGas (5e15 wei): fail.
    const shortGas = makeHarness({
      erc20Balance: 2_000_000n,
      nativeBalance: 4_000_000_000_000_000n,
    });
    const gasResult = await executeSwap(shortGas.deps, USDC_INPUT);
    expect(gasResult.status).toBe("failed");
    expect(gasResult.errorCode).toBe("insufficient_balance");
    expect(shortGas.spies.sendTransaction).not.toHaveBeenCalled();

    // Both sufficient: confirms.
    const ok = makeHarness({ erc20Balance: 2_000_000n });
    const okResult = await executeSwap(ok.deps, USDC_INPUT);
    expect(okResult.status).toBe("confirmed");
    expect(ok.transitions[0].row).toMatchObject({ amountIn: ONE_USDC });
  });

  test("rail failures write pending→failed with errorCode and no txHash", async () => {
    const h = makeHarness({ nativeBalance: BigInt(ONE_ETH) });

    const result = await executeSwap(h.deps, ETH_INPUT);

    expect(h.transitions.map((t) => t.op)).toEqual([
      "insertPending",
      "markFailed",
    ]);
    expect(h.transitions[1].errorCode).toBe("insufficient_balance");
    expect(h.transitions[1]).not.toHaveProperty("txHash");
    expect(result.txHash).toBeUndefined();
    expect(result.errorCode).toBe("insufficient_balance");
  });

  test("invalid input writes a failed row with invalid_input and no tx", async () => {
    // slippage > 5 fails validation before the re-quote.
    const slippage = makeHarness();
    const slippageResult = await executeSwap(slippage.deps, {
      ...ETH_INPUT,
      slippageTolerancePct: 6,
    });
    expect(slippageResult.status).toBe("failed");
    expect(slippageResult.errorCode).toBe("invalid_input");
    expect(slippage.transitions.map((t) => t.op)).toEqual([
      "insertPending",
      "markFailed",
    ]);
    expect(slippage.transitions[1].errorCode).toBe("invalid_input");
    expect(slippage.spies.getQuote).not.toHaveBeenCalled();
    expect(slippage.spies.sendTransaction).not.toHaveBeenCalled();

    // Zero amountIn likewise never reaches the re-quote.
    const zero = makeHarness();
    const zeroResult = await executeSwap(zero.deps, {
      ...ETH_INPUT,
      amountIn: "0",
    });
    expect(zeroResult.status).toBe("failed");
    expect(zeroResult.errorCode).toBe("invalid_input");
    expect(zero.transitions.map((t) => t.op)).toEqual([
      "insertPending",
      "markFailed",
    ]);
    expect(zero.spies.getQuote).not.toHaveBeenCalled();
    expect(zero.spies.sendTransaction).not.toHaveBeenCalled();
  });

  test("reverted receipt marks failed with swap_failed and retains txHash", async () => {
    const h = makeHarness({ receipt: { kind: "reverted" } });

    const result = await executeSwap(h.deps, ETH_INPUT);

    expect(h.transitions.map((t) => t.op)).toEqual([
      "insertPending",
      "markSubmitted",
      "markFailed",
    ]);
    // Post-submit failure keeps the broadcast hash on the failed row.
    expect(h.transitions[2]).toMatchObject({
      op: "markFailed",
      errorCode: "swap_failed",
      txHash: TX_HASH,
    });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("swap_failed");
    expect(result.txHash).toBe(TX_HASH);
  });

  test("timeout receipt leaves row submitted with timed_out result", async () => {
    const h = makeHarness({ receipt: { kind: "timeout" } });

    const result = await executeSwap(h.deps, ETH_INPUT);

    // Undetermined outcome: no markFailed/markConfirmed — the row stays submitted.
    expect(h.transitions.map((t) => t.op)).toEqual([
      "insertPending",
      "markSubmitted",
    ]);
    expect(result.status).toBe("submitted");
    expect(result.result).toBe("timed_out");
    expect(result.txHash).toBe(TX_HASH);
  });

  test("unknown receipt leaves row submitted with timed_out result", async () => {
    const h = makeHarness({ receipt: { kind: "unknown" } });

    const result = await executeSwap(h.deps, ETH_INPUT);

    expect(h.transitions.map((t) => t.op)).toEqual([
      "insertPending",
      "markSubmitted",
    ]);
    expect(result.status).toBe("submitted");
    expect(result.result).toBe("timed_out");
    expect(result.txHash).toBe(TX_HASH);
  });

  test("markConfirmed throwing after a broadcast never marks the row failed", async () => {
    // A live tx of undetermined outcome must never be reported failed:
    // a bookkeeping write throwing post-broadcast falls through to submitted.
    const h = makeHarness({
      receipt: { kind: "success", gasUsed: 21000n },
      throwOnMarkConfirmed: true,
    });

    const result = await executeSwap(h.deps, ETH_INPUT);

    expect(result.status).toBe("submitted");
    expect(result.result).toBe("timed_out");
    expect(result.txHash).toBe(TX_HASH);
    expect(h.spies.markSubmitted).toHaveBeenCalledTimes(1);
    expect(h.spies.markFailed).not.toHaveBeenCalled();
  });
});
