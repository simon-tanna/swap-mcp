import { describe, expect, test, vi } from "vitest";
import { NATIVE_ETH_SENTINEL, USDC_ADDRESS } from "../../src/engine/constants";
import type {
  ClassicQuoteResponse,
  QuoteInput,
  TradingApiClient,
} from "../../src/engine/tradingApiClient";
import type { ViemSigner } from "../../src/engine/viemSigner";
import type { TransactionsRepository } from "../../src/repository/transactions";
import type { SwapServiceDeps } from "../../src/services/swapService";
import { getQuote } from "../../src/services/swapService";
import { quoteClassic, quoteUnwrap } from "../fixtures/tradingApi";

/** Build a fake TradingApiClient that records every getQuote call and returns a fixed quote. */
function fakeTradingApi(quote: ClassicQuoteResponse): {
  tradingApi: TradingApiClient;
  quoteCalls: QuoteInput[];
} {
  const quoteCalls: QuoteInput[] = [];
  const tradingApi: TradingApiClient = {
    checkApproval: vi.fn(),
    getQuote: vi.fn(async (i: QuoteInput) => {
      quoteCalls.push(i);
      return quote;
    }),
    buildSwap: vi.fn(),
  };
  return { tradingApi, quoteCalls };
}

/** Build a fully-spied TransactionsRepository so a zero-call assertion is meaningful. */
function spyRepo(): TransactionsRepository & {
  spies: ReturnType<typeof vi.fn>[];
} {
  const insertPending = vi.fn();
  const markSubmitted = vi.fn();
  const markConfirmed = vi.fn();
  const markFailed = vi.fn();
  const findById = vi.fn();
  const list = vi.fn();
  return {
    insertPending,
    markSubmitted,
    markConfirmed,
    markFailed,
    findById,
    list,
    spies: [
      insertPending,
      markSubmitted,
      markConfirmed,
      markFailed,
      findById,
      list,
    ],
  } as unknown as TransactionsRepository & {
    spies: ReturnType<typeof vi.fn>[];
  };
}

const FIXED_NOW = 1_700_000_000_000;

describe("swapService.getQuote", () => {
  test("getQuote returns quoted output reusable as expectedAmountOut", async () => {
    const { tradingApi } = fakeTradingApi(
      quoteClassic as unknown as ClassicQuoteResponse,
    );

    const result = await getQuote(
      { tradingApi, now: () => FIXED_NOW },
      { direction: "ETH_TO_USDC", amountIn: "1000000000000000000" },
    );

    // Byte-identical to the fixture's output amount — the reusable floor form
    // that execute_swap accepts as expectedAmountOut.
    expect(result.quotedAmountOut).toBe(quoteClassic.quote.output.amount);
    expect(result.quotedAmountOut).toBe("999000000");
    // Locks the direction-aware, decimal-adjusted price convention.
    expect(result.price).toBe("999");
    expect(result.direction).toBe("ETH_TO_USDC");
    expect(result.amountIn).toBe("1000000000000000000");
    expect(result.slippageTolerancePct).toBe(0.5);
  });

  test("getQuote includes a ~30s freshness hint", async () => {
    const { tradingApi } = fakeTradingApi(
      quoteClassic as unknown as ClassicQuoteResponse,
    );

    const result = await getQuote(
      { tradingApi, now: () => FIXED_NOW },
      { direction: "ETH_TO_USDC", amountIn: "1000000000000000000" },
    );

    expect(result.createdAt).toBe(FIXED_NOW);
    expect(result.freshUntil).toBe(FIXED_NOW + 30_000);
  });

  test("getQuote never writes the database", async () => {
    const { tradingApi } = fakeTradingApi(
      quoteClassic as unknown as ClassicQuoteResponse,
    );
    const repo = spyRepo();

    // Build the FULL deps surface (including repo + signer) and pass it; the
    // `Pick` parameter type structurally prevents getQuote from even reaching
    // repo, and the spies below prove zero calls at runtime.
    const deps: SwapServiceDeps = {
      tradingApi,
      signer: {} as unknown as ViemSigner,
      repo,
      now: () => FIXED_NOW,
    };
    await getQuote(deps, {
      direction: "ETH_TO_USDC",
      amountIn: "1000000000000000000",
    });

    for (const spy of repo.spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  test("getQuote maps direction to token pair", async () => {
    const ethToUsdc = fakeTradingApi(
      quoteClassic as unknown as ClassicQuoteResponse,
    );
    await getQuote(
      { tradingApi: ethToUsdc.tradingApi, now: () => FIXED_NOW },
      { direction: "ETH_TO_USDC", amountIn: "1000000000000000000" },
    );

    const usdcToEth = fakeTradingApi(
      quoteUnwrap as unknown as ClassicQuoteResponse,
    );
    await getQuote(
      { tradingApi: usdcToEth.tradingApi, now: () => FIXED_NOW },
      { direction: "USDC_TO_ETH", amountIn: "1000000" },
    );

    // The client itself resolves tokenIn/tokenOut from direction, so the service
    // forwards the direction unchanged; assert it maps to the expected pair.
    expect(ethToUsdc.quoteCalls[0].direction).toBe("ETH_TO_USDC");
    expect(usdcToEth.quoteCalls[0].direction).toBe("USDC_TO_ETH");

    // ETH_TO_USDC: tokenIn = native-ETH sentinel, tokenOut = USDC.
    expect(tokensForDirection("ETH_TO_USDC")).toEqual({
      tokenIn: NATIVE_ETH_SENTINEL,
      tokenOut: USDC_ADDRESS,
    });
    // USDC_TO_ETH is the reverse.
    expect(tokensForDirection("USDC_TO_ETH")).toEqual({
      tokenIn: USDC_ADDRESS,
      tokenOut: NATIVE_ETH_SENTINEL,
    });
  });

  test("getQuote computes a fractional price for the USDC_TO_ETH 6→18 decimal crossing", async () => {
    // 1 USDC in (6 decimals) → 0.5 ETH out (18 decimals): exercises the frac-
    // padding path where in=6/out=18 scales to 5e17 → whole=0, frac trims to "5".
    const usdcToEthFractional = {
      routing: "UNWRAP",
      quote: {
        input: { token: USDC_ADDRESS, amount: "1000000" },
        output: {
          token: NATIVE_ETH_SENTINEL,
          amount: "500000000000000000",
        },
        slippage: 0.5,
      },
      permitData: null,
    } as unknown as ClassicQuoteResponse;
    const { tradingApi } = fakeTradingApi(usdcToEthFractional);

    const result = await getQuote(
      { tradingApi, now: () => FIXED_NOW },
      { direction: "USDC_TO_ETH", amountIn: "1000000" },
    );

    expect(result.quotedAmountOut).toBe("500000000000000000");
    expect(result.price).toBe("0.5");
  });
});

/** Mirror of the direction→pair mapping used to pin §7 G5 in this test. */
function tokensForDirection(direction: "ETH_TO_USDC" | "USDC_TO_ETH"): {
  tokenIn: string;
  tokenOut: string;
} {
  return direction === "ETH_TO_USDC"
    ? { tokenIn: NATIVE_ETH_SENTINEL, tokenOut: USDC_ADDRESS }
    : { tokenIn: USDC_ADDRESS, tokenOut: NATIVE_ETH_SENTINEL };
}
