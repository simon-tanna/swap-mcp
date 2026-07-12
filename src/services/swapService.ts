import {
  readQuotedOutput,
  type SwapDirection,
  type TradingApiClient,
} from "../engine/tradingApiClient";
import type { ViemSigner } from "../engine/viemSigner";
import type { TransactionsRepository } from "../repository/transactions";

/**
 * Read-path quotes are swapper-agnostic (a price quote does not bind funds), so
 * we pass the zero address here as a documented placeholder. The real swapper
 * binds at execute time (T17), where the signer's address is available.
 */
const QUOTE_PLACEHOLDER_SWAPPER =
  "0x0000000000000000000000000000000000000000" as const;

/** Default slippage tolerance applied when the caller supplies none. */
const DEFAULT_SLIPPAGE_TOLERANCE_PCT = 0.5;

/** Freshness window for a quote; the Trading API has no expiry field, so we hint one. */
const QUOTE_FRESHNESS_MS = 30_000;

/** Fixed token decimals for the ETH↔USDC pair, used for decimal-adjusted price math. */
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

/** Resolve the (inDecimals, outDecimals) for a direction over the fixed ETH↔USDC pair. */
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
