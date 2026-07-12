import { AppError } from "../errors";
import {
  MAINNET_CHAIN_ID,
  NATIVE_ETH_SENTINEL,
  USDC_ADDRESS,
} from "./constants";

/** Swap direction between native ETH and USDC on Ethereum mainnet. */
export type SwapDirection = "ETH_TO_USDC" | "USDC_TO_ETH";

/** Inputs for a `/quote` request; token addresses are derived from `direction`. */
export type QuoteInput = {
  direction: SwapDirection;
  amount: string;
  swapper: string;
  slippageTolerancePct: number;
};

/** CLASSIC-family `/quote` response — the only routing this client accepts. */
export type ClassicQuoteResponse = {
  routing: "CLASSIC" | "WRAP" | "UNWRAP";
  quote: {
    input: { token: string; amount: string };
    output: { token: string; amount: string };
    slippage: number;
    route: unknown[];
    gasFee: string;
    gasFeeUSD: string;
    gasUseEstimate: string;
  };
  permitData?: Record<string, unknown> | null;
  permitTransaction?: Record<string, unknown> | null;
};

/** The ready-to-sign swap transaction unwrapped from the `/swap` `{ swap }` envelope. */
export type SwapTx = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  gasLimit: string;
};

/** Client for the Uniswap Trading API check_approval → quote → swap flow. */
export interface TradingApiClient {
  checkApproval(i: {
    token: string;
    amount: string;
    walletAddress: string;
  }): Promise<{ approval: unknown | null }>;
  getQuote(i: QuoteInput): Promise<ClassicQuoteResponse>;
  buildSwap(q: ClassicQuoteResponse): Promise<SwapTx>;
}

/** Routing families whose response carries a `quote.output.amount`. */
const CLASSIC_FAMILY = new Set(["CLASSIC", "WRAP", "UNWRAP"]);

/** Assert a quote is CLASSIC-family; anything else (e.g. UniswapX) fails closed. */
export function assertClassicFamilyRouting(q: {
  routing: string;
}): asserts q is ClassicQuoteResponse {
  if (!CLASSIC_FAMILY.has(q.routing)) {
    throw new AppError("upstream_unavailable");
  }
}

/** Read the quoted output amount via a routing-aware accessor (never a bare read). */
export function readQuotedOutput(q: ClassicQuoteResponse): string {
  assertClassicFamilyRouting(q);
  return q.quote.output.amount;
}

/** Resolve the `tokenIn`/`tokenOut` pair for a direction, using the ETH sentinel. */
function tokensFor(direction: SwapDirection): {
  tokenIn: string;
  tokenOut: string;
} {
  return direction === "ETH_TO_USDC"
    ? { tokenIn: NATIVE_ETH_SENTINEL, tokenOut: USDC_ADDRESS }
    : { tokenIn: USDC_ADDRESS, tokenOut: NATIVE_ETH_SENTINEL };
}

/** Construct a Trading API client bound to a base URL and API-key accessor. */
export function createTradingApiClient(deps: {
  baseUrl: string;
  getApiKey: () => string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): TradingApiClient {
  const doFetch = deps.fetchImpl ?? fetch;

  async function post(path: string, body: unknown): Promise<unknown> {
    const res = await doFetch(`${deps.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "x-api-key": deps.getApiKey(),
        "Content-Type": "application/json",
        "x-universal-router-version": "2.0",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new AppError("upstream_unavailable");
    }
    try {
      return await res.json();
    } catch {
      throw new AppError("upstream_unavailable");
    }
  }

  return {
    async checkApproval(i) {
      return (await post("/check_approval", {
        walletAddress: i.walletAddress,
        token: i.token,
        amount: i.amount,
        chainId: MAINNET_CHAIN_ID,
      })) as { approval: unknown | null };
    },

    async getQuote(i) {
      const { tokenIn, tokenOut } = tokensFor(i.direction);
      const response = (await post("/quote", {
        type: "EXACT_INPUT",
        tokenIn,
        tokenOut,
        tokenInChainId: MAINNET_CHAIN_ID,
        tokenOutChainId: MAINNET_CHAIN_ID,
        amount: i.amount,
        swapper: i.swapper,
        slippageTolerance: i.slippageTolerancePct,
        routingPreference: "CLASSIC",
      })) as { routing: string };
      assertClassicFamilyRouting(response);
      return response;
    },

    async buildSwap(q) {
      const { permitData, permitTransaction, ...cleanQuote } = q;
      const response = (await post("/swap", cleanQuote)) as {
        swap?: SwapTx | null;
      };
      const swap = response?.swap;
      if (!swap || typeof swap !== "object") {
        throw new AppError("upstream_unavailable");
      }
      const { to, data, value, chainId, gasLimit } = swap;
      return { to, data, value, chainId, gasLimit };
    },
  };
}
