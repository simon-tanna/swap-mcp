import { USDC_ADDRESS } from "../engine/constants";
import {
  readQuotedOutput,
  type ClassicQuoteResponse,
  type SwapDirection,
  type TradingApiClient,
} from "../engine/tradingApiClient";
import type { ViemSigner } from "../engine/viemSigner";
import { classify, type ErrorCode } from "../errors";
import { log, safeError } from "../log";
import type { TransactionsRepository } from "../repository/transactions";
import { checkDrift, resolveSwapParams, type ExecuteSwapInput } from "./rails";

/**
 * Read-path quotes are swapper-agnostic (a price quote does not bind funds), so
 * we pass the zero address here as a documented placeholder. The real swapper
 * binds at execute time, where the signer's address is available.
 */
const QUOTE_PLACEHOLDER_SWAPPER =
  "0x0000000000000000000000000000000000000000" as const;

const DEFAULT_SLIPPAGE_TOLERANCE_PCT = 0.5;

/** Freshness window for a quote; the Trading API has no expiry field, so we hint one. */
const QUOTE_FRESHNESS_MS = 30_000;

const ETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

/** Fractional digits retained in the intermediate scaled price before trimming; unrelated to token decimals. */
const PRICE_PRECISION_DIGITS = 18;

/** Ports the swap service depends on; `getQuote` uses only `tradingApi` and `now`. */
export type SwapServiceDeps = {
  tradingApi: TradingApiClient;
  signer: ViemSigner;
  repo: TransactionsRepository;
  now?: () => number;
};

/** A price quote plus a service-computed freshness hint; carries no key/DB state. */
export type QuoteResult = {
  direction: SwapDirection;
  amountIn: string;
  quotedAmountOut: string;
  /** Quote-token-out per 1 token-in, decimal-adjusted (e.g. "999" for 1 ETH → 999 USDC). */
  price: string;
  slippageTolerancePct: number;
  createdAt: number;
  freshUntil: number;
};

function decimalsFor(direction: SwapDirection): {
  in: number;
  out: number;
} {
  return direction === "ETH_TO_USDC"
    ? { in: ETH_DECIMALS, out: USDC_DECIMALS }
    : { in: USDC_DECIMALS, out: ETH_DECIMALS };
}

/**
 * Compute output-per-1-input as a decimal string using BigInt scaling, so large
 * 18-decimal (wei) values never lose precision through binary-float division.
 * Trailing zeros are trimmed (999.000 → "999"); a whole result drops the point.
 * Truncates (does not round) toward zero; acceptable because this value is
 * display-only and is never used as the `expectedAmountOut` drift floor.
 */
function decimalAdjustedPrice(
  amountIn: string,
  amountOut: string,
  decimals: { in: number; out: number },
): string {
  const inRaw = BigInt(amountIn);
  if (inRaw === 0n) return "0";
  const outRaw = BigInt(amountOut);

  // price = (outRaw / 10^outDec) / (inRaw / 10^inDec)
  //       = outRaw * 10^inDec / (inRaw * 10^outDec)
  // Scale the numerator by an extra 10^PRICE_PRECISION_DIGITS for fractional digits.
  const numerator =
    outRaw * 10n ** BigInt(decimals.in + PRICE_PRECISION_DIGITS);
  const denominator = inRaw * 10n ** BigInt(decimals.out);
  const scaled = numerator / denominator;

  const scale = 10n ** BigInt(PRICE_PRECISION_DIGITS);
  const whole = scaled / scale;
  let frac = (scaled % scale).toString().padStart(PRICE_PRECISION_DIGITS, "0");
  frac = frac.replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole.toString();
}

/**
 * Fetch a CLASSIC price quote for `direction`/`amountIn` and attach a
 * service-computed 30s freshness hint. `quotedAmountOut` is the base-unit output
 * string reusable verbatim as `execute_swap`'s `expectedAmountOut` floor. Never
 * touches the signer or repository — a quote is a pure read.
 */
export async function getQuote(
  deps: Pick<SwapServiceDeps, "tradingApi" | "now">,
  input: { direction: SwapDirection; amountIn: string },
): Promise<QuoteResult> {
  const slippageTolerancePct = DEFAULT_SLIPPAGE_TOLERANCE_PCT;

  const quote = await deps.tradingApi.getQuote({
    direction: input.direction,
    amount: input.amountIn,
    swapper: QUOTE_PLACEHOLDER_SWAPPER,
    slippageTolerancePct,
  });

  const quotedAmountOut = readQuotedOutput(quote);
  const price = decimalAdjustedPrice(
    input.amountIn,
    quotedAmountOut,
    decimalsFor(input.direction),
  );

  const createdAt = deps.now?.() ?? Date.now();
  return {
    direction: input.direction,
    amountIn: input.amountIn,
    quotedAmountOut,
    price,
    slippageTolerancePct,
    createdAt,
    freshUntil: createdAt + QUOTE_FRESHNESS_MS,
  };
}

/** Outcome of one executeSwap run; `result:"timed_out"` means the row stays `submitted`. */
export type SwapResult = {
  transactionId: string;
  status: "confirmed" | "failed" | "submitted";
  result: "ok" | "timed_out";
  txHash?: string;
  quotedAmountOut?: string;
  /** Currently the quoted output (no on-chain amount decoding exists yet); consumers must not treat it as receipt-decoded reality. */
  actualAmountOut?: string;
  gasUsed?: string;
  errorCode?: ErrorCode;
};

/**
 * Gas-headroom buffer as a ratio (120/100 = 20% over the estimated gas cost):
 * the fee estimate is a snapshot, and fees can rise between the estimate and
 * inclusion, so a balance covering exactly `amountIn + gasCost` must still fail.
 */
const GAS_HEADROOM_NUM = 120n;
const GAS_HEADROOM_DEN = 100n;

/** Apply the gas-headroom buffer to a raw gas cost; direction-independent (gas is ETH either way). */
function gasWithHeadroom(gasCost: bigint): bigint {
  return (gasCost * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN;
}

/**
 * Provisional `quotedAmountOut` for rows that fail before a valid quote exists
 * (invalid input, or a re-quote that fails the routing assertion). The column
 * is NOT NULL and write-once, so the undetermined output is recorded as "0".
 */
const QUOTED_AMOUNT_OUT_UNDETERMINED = "0";

/**
 * Insert a row capturing a swap attempt that aborted before a valid quote,
 * mark it failed, and return the failed result. Every abort still yields a
 * pending→failed row so the attempt is auditable.
 */
async function failBeforeQuote(
  repo: TransactionsRepository,
  input: ExecuteSwapInput & { userId: string },
  errorCode: ErrorCode,
): Promise<SwapResult> {
  const transactionId = await repo.insertPending({
    userId: input.userId,
    direction: input.direction,
    amountIn: input.amountIn,
    ...(input.expectedAmountOut !== undefined && {
      expectedAmountOut: input.expectedAmountOut,
    }),
    quotedAmountOut: QUOTED_AMOUNT_OUT_UNDETERMINED,
    slippageTolerancePct: String(
      input.slippageTolerancePct ?? DEFAULT_SLIPPAGE_TOLERANCE_PCT,
    ),
    deadlineSeconds: input.deadlineSeconds ?? 1200,
  });
  await repo.markFailed(transactionId, errorCode);
  return { transactionId, status: "failed", result: "ok", errorCode };
}

/**
 * Execute a swap end-to-end: validate, re-quote with the real signer as
 * swapper, persist a pending row, then run the drift, approval and
 * balance/gas-headroom rails before signing and submitting. Every abort marks
 * the row failed; only a receipt timeout/unknown leaves it `submitted`.
 */
export async function executeSwap(
  deps: SwapServiceDeps,
  input: ExecuteSwapInput & { userId: string },
): Promise<SwapResult> {
  const { tradingApi, signer, repo } = deps;

  // Structured stage breadcrumbs: allowlisted, non-secret context only. `stage`
  // is threaded through so the pre-broadcast catch reports WHICH rail threw, and
  // every failure log carries a secret-safe `safeError` identity (never the raw
  // error). This is what makes an opaque failure diagnosable in production.
  const base = { event: "executeSwap", direction: input.direction } as const;
  const breadcrumb = (stage: string): void => log("info", { ...base, stage });

  // 1. Validate shape first — a malformed/zero amount cannot be re-quoted.
  breadcrumb("validate");
  let params: ReturnType<typeof resolveSwapParams>;
  try {
    params = resolveSwapParams(input);
  } catch (err) {
    log("error", { ...base, stage: "validate", ...safeError(err) });
    return failBeforeQuote(repo, input, classify(err));
  }

  // 2–3. Re-quote immediately before submission, bound to the real signer, and
  // read the output through the routing assertion (non-CLASSIC fails closed).
  breadcrumb("requote");
  let reQuote: ClassicQuoteResponse;
  let quotedAmountOut: string;
  try {
    reQuote = await tradingApi.getQuote({
      direction: params.direction,
      amount: params.amountIn,
      swapper: signer.address,
      slippageTolerancePct: params.slippageTolerancePct,
    });
    quotedAmountOut = readQuotedOutput(reQuote);
  } catch (err) {
    log("error", { ...base, stage: "requote", ...safeError(err) });
    return failBeforeQuote(repo, input, classify(err));
  }

  // 4. Persist the pending row with the real quoted output (write-once column).
  // A D1 throw here sits OUTSIDE every service try, so it propagates to the
  // coordinator outer catch (which emits the full `safeError`); log only a
  // context-only stage tag here to avoid a duplicate payload for one failure.
  breadcrumb("insert_pending");
  let transactionId: string;
  try {
    transactionId = await repo.insertPending({
      userId: input.userId,
      direction: params.direction,
      amountIn: params.amountIn,
      ...(params.expectedAmountOut !== undefined && {
        expectedAmountOut: params.expectedAmountOut,
      }),
      quotedAmountOut,
      slippageTolerancePct: String(params.slippageTolerancePct),
      deadlineSeconds: params.deadlineSeconds,
    });
  } catch (err) {
    log("error", { ...base, stage: "insert_pending", errorCode: "internal" });
    throw err;
  }

  const fail = async (errorCode: ErrorCode): Promise<SwapResult> => {
    await repo.markFailed(transactionId, errorCode);
    return {
      transactionId,
      status: "failed",
      result: "ok",
      quotedAmountOut,
      errorCode,
    };
  };

  let txHash: string;
  let swapTx: Awaited<ReturnType<typeof tradingApi.buildSwap>>;
  // Tracks the active pre-broadcast rail so the catch can report which one threw.
  let stage = "drift";
  try {
    // 5. Drift rail: only fires against a caller-supplied floor; when omitted
    // the Trading-API-embedded slippage floor in the calldata is the sole rail.
    breadcrumb("drift");
    const drift = checkDrift(
      BigInt(quotedAmountOut),
      params.expectedAmountOut !== undefined
        ? BigInt(params.expectedAmountOut)
        : undefined,
      params.slippageTolerancePct,
    );
    if (drift.abort) {
      return fail("slippage_exceeded");
    }

    // 6. Approval gate — only the ERC-20 input direction needs a Universal
    // Router allowance; native ETH input has no allowance concept.
    stage = "approval";
    if (params.direction === "USDC_TO_ETH") {
      breadcrumb("approval");
      const { approval } = await tradingApi.checkApproval({
        token: USDC_ADDRESS,
        amount: params.amountIn,
        walletAddress: signer.address,
      });
      if (approval !== null) {
        // Approval is a separate user-authorised transaction; never auto-send it.
        return fail("approval_required");
      }
    }

    // 7. Build the transaction from the spread re-quote; the slippage floor is
    // already embedded in the returned calldata, so no amountOutMinimum here.
    stage = "build_swap";
    breadcrumb("build_swap");
    swapTx = await tradingApi.buildSwap(reQuote);

    // 8. Balance/gas-headroom rail — after buildSwap so the shortfall check
    // consumes the real gasLimit, before any signing or submission. The buffer
    // is applied to gas in both directions (fee-rise risk is ETH-denominated).
    stage = "balance_check";
    breadcrumb("balance_check");
    const gasCost =
      BigInt(swapTx.gasLimit) * (await signer.estimateMaxFeePerGas());
    if (params.direction === "ETH_TO_USDC") {
      // Input and gas both draw on native ETH: exactly amountIn must fail.
      const required = BigInt(params.amountIn) + gasWithHeadroom(gasCost);
      const nativeBalance = await signer.getNativeBalance(signer.address);
      if (nativeBalance < required) {
        return fail("insufficient_balance");
      }
    } else {
      // ERC-20 covers the input; gas is still paid in native ETH.
      const erc20Balance = await signer.getErc20Balance(
        USDC_ADDRESS,
        signer.address,
      );
      if (erc20Balance < BigInt(params.amountIn)) {
        return fail("insufficient_balance");
      }
      const nativeBalance = await signer.getNativeBalance(signer.address);
      if (nativeBalance < gasWithHeadroom(gasCost)) {
        return fail("insufficient_balance");
      }
    }

    // 9. Sign and submit. Nothing has broadcast until this resolves, so any
    // throw up to here means failing (no txHash) is correct.
    stage = "sign_submit";
    breadcrumb("sign_submit");
    txHash = await signer.sendTransaction({
      to: swapTx.to,
      data: swapTx.data,
      value: swapTx.value,
    });
  } catch (err) {
    // Pre-broadcast throw: nothing landed on-chain, so close the row failed.
    // This RETURNS a SwapResult — it never reaches the coordinator outer catch —
    // so the failing stage + safe error identity are logged HERE (a raw viem
    // sendTransaction / RPC error would otherwise vanish into a bare `internal`).
    const errorCode = classify(err);
    log("error", {
      ...base,
      stage,
      transactionId,
      errorCode,
      ...safeError(err),
    });
    return fail(errorCode);
  }

  // Post-broadcast region: the tx is live. A bookkeeping write throwing here
  // must NEVER mark the row failed — the outcome is undetermined, so the
  // catch falls through to the submitted/timed_out result.
  breadcrumb("receipt");
  try {
    await repo.markSubmitted(transactionId, txHash);

    // 10. Wait for the receipt and map the outcome.
    const outcome = await signer.waitForReceipt(
      txHash,
      params.deadlineSeconds * 1000,
    );
    if (outcome.kind === "success") {
      // No decoded on-chain output is available; record the quoted amount as
      // the confirmed output.
      const actualAmountOut = quotedAmountOut;
      const gasUsed = String(outcome.gasUsed);
      await repo.markConfirmed(transactionId, { actualAmountOut, gasUsed });
      return {
        transactionId,
        status: "confirmed",
        result: "ok",
        txHash,
        quotedAmountOut,
        actualAmountOut,
        gasUsed,
      };
    }
    if (outcome.kind === "reverted") {
      await repo.markFailed(transactionId, "swap_failed", { txHash });
      return {
        transactionId,
        status: "failed",
        result: "ok",
        txHash,
        quotedAmountOut,
        errorCode: "swap_failed",
      };
    }
    // timeout/unknown: the swap may still have succeeded, so the row stays
    // `submitted` — never write `failed` for an undetermined outcome.
    return {
      transactionId,
      status: "submitted",
      result: "timed_out",
      txHash,
      quotedAmountOut,
    };
  } catch (err) {
    // A post-broadcast bookkeeping write (markSubmitted/markConfirmed) threw for
    // a live tx of undetermined outcome: leave the row as-is and report
    // submitted/timed_out rather than fabricating a `failed` state. Tagged
    // `terminal:false` so this NON-fatal log is not misread as a swap failure —
    // the tx is live and its outcome is still undetermined.
    log("error", {
      ...base,
      stage: "receipt",
      terminal: false,
      transactionId,
      ...safeError(err),
    });
    return {
      transactionId,
      status: "submitted",
      result: "timed_out",
      txHash,
      quotedAmountOut,
    };
  }
}
