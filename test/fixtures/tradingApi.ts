import {
  NATIVE_ETH_SENTINEL,
  USDC_ADDRESS,
  UNIVERSAL_ROUTER_ADDRESS,
  WETH9_ADDRESS,
} from "../../src/engine/constants";

/** A pinned swapper address used across Trading API fixtures. */
export const FIXTURE_SWAPPER =
  "0x1111111111111111111111111111111111111111" as const;

/** `/check_approval` response where an approval transaction is required. */
export const checkApprovalNonNull = {
  approval: {
    to: USDC_ADDRESS,
    from: FIXTURE_SWAPPER,
    data: "0xabc123",
    value: "0",
    chainId: 1,
  },
} as const;

/** `/check_approval` response where the token is already approved. */
export const checkApprovalNull = { approval: null } as const;

/** CLASSIC `/quote` response with a routing-aware `quote.output.amount`. */
export const quoteClassic = {
  routing: "CLASSIC",
  quote: {
    input: { token: NATIVE_ETH_SENTINEL, amount: "1000000000000000000" },
    output: { token: USDC_ADDRESS, amount: "999000000" },
    slippage: 0.5,
    route: [],
    gasFee: "5000000000000000",
    gasFeeUSD: "0.01",
    gasUseEstimate: "150000",
  },
  permitData: null,
  permitTransaction: null,
} as const;

/** WRAP `/quote` response (ETH to WETH), same CLASSIC-family output shape. */
export const quoteWrap = {
  routing: "WRAP",
  quote: {
    input: { token: NATIVE_ETH_SENTINEL, amount: "1000000000000000000" },
    output: { token: WETH9_ADDRESS, amount: "1000000000000000000" },
    slippage: 0.5,
    route: [],
    gasFee: "2000000000000000",
    gasFeeUSD: "0.005",
    gasUseEstimate: "50000",
  },
  permitData: null,
} as const;

/** UNWRAP `/quote` response (WETH to ETH), same CLASSIC-family output shape. */
export const quoteUnwrap = {
  routing: "UNWRAP",
  quote: {
    input: { token: WETH9_ADDRESS, amount: "1000000000000000000" },
    output: { token: NATIVE_ETH_SENTINEL, amount: "1000000000000000000" },
    slippage: 0.5,
    route: [],
    gasFee: "2000000000000000",
    gasFeeUSD: "0.005",
    gasUseEstimate: "50000",
  },
  permitData: null,
} as const;

/** CLASSIC `/quote` response with `quote` present but no `output.amount`; fails closed. */
export const quoteClassicMissingOutput = {
  routing: "CLASSIC",
  quote: {
    input: { token: NATIVE_ETH_SENTINEL, amount: "1000000000000000000" },
    output: { token: USDC_ADDRESS },
    slippage: 0.5,
    route: [],
    gasFee: "5000000000000000",
    gasFeeUSD: "0.01",
    gasUseEstimate: "150000",
  },
  permitData: null,
} as const;

/** CLASSIC `/quote` response with the `quote` key entirely absent; fails closed. */
export const quoteClassicNoQuote = {
  routing: "CLASSIC",
  permitData: null,
} as const;

/**
 * CLASSIC `/quote` carrying extras BOTH at the top level AND inside
 * `quote.output` — the loose-preservation guard for the `/swap` re-spread.
 */
export const quoteClassicNestedExtras = {
  routing: "CLASSIC",
  quote: {
    input: { token: NATIVE_ETH_SENTINEL, amount: "1000000000000000000" },
    output: {
      token: USDC_ADDRESS,
      amount: "999000000",
      syntheticOutputExtra: "nested-keep",
    },
    slippage: 0.5,
    route: [],
    gasFee: "5000000000000000",
    gasFeeUSD: "0.01",
    gasUseEstimate: "150000",
    syntheticQuoteExtra: "quote-level-keep",
  },
  topLevelExtra: "top-keep",
  permitData: null,
  permitTransaction: null,
} as const;

/** `/swap` response with `swap` present but missing the `gasLimit` field; fails closed. */
export const swapMissingField = {
  swap: {
    to: UNIVERSAL_ROUTER_ADDRESS,
    from: FIXTURE_SWAPPER,
    data: "0xfeed",
    value: "1000000000000000000",
    chainId: 1,
  },
} as const;

/** Malformed `/check_approval` responses whose `approval` value violates the object-or-null contract. */
export const checkApprovalMalformed = {
  /** `approval` key entirely absent. */
  missingKey: { detail: "no approval field" },
  /** `approval` is a string, not an object or null. */
  stringValue: { approval: "0xnotanobject" },
  /** `approval` is an array, not an object or null. */
  arrayValue: { approval: [] as unknown[] },
} as const;

/** DUTCH_V2 (UniswapX) `/quote` response — no `quote.output`; must fail closed. */
export const quoteDutchV2 = {
  routing: "DUTCH_V2",
  quote: {
    orderInfo: {
      reactor: "0x2222222222222222222222222222222222222222",
      swapper: FIXTURE_SWAPPER,
      nonce: "1",
      deadline: 1772031054,
      input: {
        token: NATIVE_ETH_SENTINEL,
        startAmount: "1000000000000000000",
        endAmount: "1000000000000000000",
      },
      outputs: [
        {
          token: USDC_ADDRESS,
          startAmount: "999000000",
          endAmount: "994000000",
          recipient: FIXTURE_SWAPPER,
        },
      ],
      chainId: 1,
    },
    encodedOrder: "0xdead",
    orderHash: "0xbeef",
  },
  permitData: { domain: {}, types: {}, values: {} },
} as const;

/** Malformed `/swap` response missing the `swap` envelope key entirely. */
export const swapMissingKey = { detail: "quote expired" } as const;

/** `/swap` response — the executable transaction is nested under `{ swap }`. */
export const swapNested = {
  swap: {
    to: UNIVERSAL_ROUTER_ADDRESS,
    from: FIXTURE_SWAPPER,
    data: "0xfeed",
    value: "1000000000000000000",
    chainId: 1,
    gasLimit: "250000",
  },
} as const;
