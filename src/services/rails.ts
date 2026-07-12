import { AppError } from "../errors";
import type { SwapDirection } from "../db/schema";

/** Caller-facing input to a swap, before defaults and validation are applied. */
export type ExecuteSwapInput = {
  direction: SwapDirection;
  amountIn: string;
  expectedAmountOut?: string;
  slippageTolerancePct?: number;
  deadlineSeconds?: number;
};

/** Validated swap parameters with defaults applied, ready for execution. */
export type ResolvedSwapParams = {
  direction: SwapDirection;
  amountIn: string;
  slippageTolerancePct: number;
  deadlineSeconds: number;
  expectedAmountOut?: string;
};

/** Apply defaults (slippage 0.5, deadline 1200) and validate; throws AppError("invalid_input") on any violation. */
export function resolveSwapParams(input: ExecuteSwapInput): ResolvedSwapParams {
  const slippageTolerancePct = input.slippageTolerancePct ?? 0.5;
  if (
    !Number.isFinite(slippageTolerancePct) ||
    slippageTolerancePct <= 0 ||
    slippageTolerancePct > 5
  ) {
    throw new AppError("invalid_input");
  }

  const deadlineSeconds = input.deadlineSeconds ?? 1200;
  if (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0) {
    throw new AppError("invalid_input");
  }

  // Validate regex FIRST so BigInt() can never throw on a malformed string.
  // Leading zeros (e.g. "007") are deliberately accepted and echoed back verbatim;
  // the canonical numeric value is derived via BigInt downstream, which is idempotent.
  if (!/^\d+$/.test(input.amountIn) || BigInt(input.amountIn) <= 0n) {
    throw new AppError("invalid_input");
  }

  return {
    direction: input.direction,
    amountIn: input.amountIn,
    slippageTolerancePct,
    deadlineSeconds,
    ...(input.expectedAmountOut !== undefined && {
      expectedAmountOut: input.expectedAmountOut,
    }),
  };
}

/** Convert a percent to a fraction (0.5 → 0.005), for API/boundary use — NOT used in drift math. */
export function pctToFraction(pct: number): number {
  return pct / 100;
}

/** Convert a percent to integer basis points (0.5 → 50n), collapsing the float to a bigint immediately. */
export function pctToBps(pct: number): bigint {
  return BigInt(Math.round(pct * 100));
}

/**
 * Decide whether fresh output has drifted below the caller-supplied expected floor.
 *
 * When expectedAmountOut is undefined the branch NEVER aborts: the Trading-API-embedded
 * slippage floor is the only rail in that case, so applying a second local floor here would
 * double-count slippage (the v2 double-count bug). Otherwise the floor is computed purely in
 * bigint from integer basis points — no float touches the amount arithmetic.
 */
export function checkDrift(
  freshOut: bigint,
  expectedAmountOut: bigint | undefined,
  slippageTolerancePct: number,
): { abort: boolean } {
  if (expectedAmountOut === undefined) {
    return { abort: false };
  }
  const tolBps = pctToBps(slippageTolerancePct);
  const floor = expectedAmountOut - (expectedAmountOut * tolBps) / 10000n;
  return { abort: freshOut < floor };
}
