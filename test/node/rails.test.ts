import { describe, expect, test } from "vitest";
import { AppError } from "../../src/errors";
import {
  checkDrift,
  pctToBps,
  pctToFraction,
  resolveSwapParams,
} from "../../src/services/rails";

describe("rails", () => {
  test("slippage defaults to 0.5 and caps at 5", () => {
    const resolved = resolveSwapParams({
      direction: "ETH_TO_USDC",
      amountIn: "1000000",
    });
    expect(resolved.slippageTolerancePct).toBe(0.5);

    expect(
      resolveSwapParams({
        direction: "ETH_TO_USDC",
        amountIn: "1000000",
        slippageTolerancePct: 5,
      }).slippageTolerancePct,
    ).toBe(5);

    expect(() =>
      resolveSwapParams({
        direction: "ETH_TO_USDC",
        amountIn: "1000000",
        slippageTolerancePct: 5.1,
      }),
    ).toThrow(new AppError("invalid_input"));
  });

  test("deadline defaults to 1200", () => {
    const resolved = resolveSwapParams({
      direction: "ETH_TO_USDC",
      amountIn: "1000000",
    });
    expect(resolved.deadlineSeconds).toBe(1200);
  });

  test("amountIn must be a positive base-unit integer", () => {
    for (const bad of ["0", "-1", "1.5", ""]) {
      expect(() =>
        resolveSwapParams({ direction: "ETH_TO_USDC", amountIn: bad }),
      ).toThrow(new AppError("invalid_input"));
    }
    expect(
      resolveSwapParams({ direction: "ETH_TO_USDC", amountIn: "1000000" })
        .amountIn,
    ).toBe("1000000");
  });

  test("pctToFraction converts percent to fraction", () => {
    expect(pctToFraction(0.5)).toBe(0.005);
  });

  test("drift check — caller-supplied floor branch", () => {
    // integer-bps pin: no float ever enters the bigint amount math.
    expect(pctToBps(0.5)).toBe(50n);
    expect(pctToBps(5)).toBe(500n);
    expect(typeof pctToBps(0.5)).toBe("bigint");

    // floor = 1000 − 1000×50/10000 = 995
    expect(checkDrift(994n, 1000n, 0.5)).toEqual({ abort: true });
    expect(checkDrift(996n, 1000n, 0.5)).toEqual({ abort: false });
  });

  test("drift check — omitted floor branch never aborts", () => {
    expect(checkDrift(1n, undefined, 0.5)).toEqual({ abort: false });
    expect(checkDrift(999999n, undefined, 5)).toEqual({ abort: false });
  });

  test("drift check — boundary and zero-expected edges", () => {
    // floor = 1000 − 1000×50/10000 = 995; fresh === floor is NOT abort (strict <).
    expect(checkDrift(995n, 1000n, 0.5)).toEqual({ abort: false });
    // expected 0 → floor 0; 0 < 0 is false, so no abort.
    expect(checkDrift(0n, 0n, 0.5)).toEqual({ abort: false });
  });

  test("non-finite slippage is rejected at the validation boundary", () => {
    expect(() =>
      resolveSwapParams({
        direction: "ETH_TO_USDC",
        amountIn: "1000000",
        slippageTolerancePct: NaN,
      }),
    ).toThrow(new AppError("invalid_input"));

    expect(() =>
      resolveSwapParams({
        direction: "ETH_TO_USDC",
        amountIn: "1000000",
        slippageTolerancePct: Infinity,
      }),
    ).toThrow(new AppError("invalid_input"));
  });

  test("non-finite deadline is rejected at the validation boundary", () => {
    expect(() =>
      resolveSwapParams({
        direction: "ETH_TO_USDC",
        amountIn: "1000000",
        deadlineSeconds: NaN,
      }),
    ).toThrow(new AppError("invalid_input"));
  });
});
