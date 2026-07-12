import { AppError } from "../errors";
import {
  MAINNET_CHAIN_ID,
  NATIVE_ETH_SENTINEL,
  USDC_ADDRESS,
} from "./constants";

/**
 * Internal-only carrier of a non-2xx status through the retry layer. Never
 * escapes `createTradingApiClient` — the boundary collapses it to
 * `AppError("upstream_unavailable")` so callers only ever see allowlisted codes.
 */
class UpstreamError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`upstream ${status}`);
    this.name = "UpstreamError";
    this.status = status;
  }
  /** Retryable iff the gateway signalled rate-limiting (429) or a 5xx fault. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

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

/** Per-Trading-API-call timeout: a slower call maps to `upstream_unavailable` (spec §5.9). */
const CALL_TIMEOUT_MS = 8000;

/** Backoff bases before retry 1 and retry 2; length also caps retries at 2 (spec §5.9). */
const RETRY_BASE_MS = [250, 500] as const;

/** A distinct sentinel used to win the timeout race against a hung `fetch`. */
const TIMEOUT = Symbol("trading-api-timeout");

/** Construct a Trading API client bound to a base URL and API-key accessor. */
export function createTradingApiClient(deps: {
  baseUrl: string;
  getApiKey: () => string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): TradingApiClient {
  const doFetch = deps.fetchImpl ?? fetch;
  // Injected seams so fake timers can drive the timeout/backoff deterministically.
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;

  /**
   * Jittered exponential backoff, pinned to `delay = base + random() * base`,
   * yielding delay ∈ [base, 2×base). With `random() === 0.5` a 250ms base
   * becomes 375ms. The formula is load-bearing — tests assert it exactly.
   */
  function backoffDelay(base: number): number {
    return base + random() * base;
  }

  /**
   * One `fetch` + response-classification attempt, bounded by an 8s timeout.
   *
   * The timeout is an `AbortController` armed with `setTimeout`: on expiry it
   * aborts the in-flight request (so an abandoned `/swap` submission cannot
   * still land upstream after we returned `upstream_unavailable`) and resolves
   * the race with `TIMEOUT`. The timer is always cleared in `finally`, so no 8s
   * timer survives a completed call on the winning (fetch-resolves) path.
   */
  async function attempt(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMEOUT);
      }, CALL_TIMEOUT_MS);
    });
    try {
      const fetchPromise = doFetch(`${deps.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "x-api-key": deps.getApiKey(),
          "Content-Type": "application/json",
          "x-universal-router-version": "2.0",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const res = await Promise.race([fetchPromise, timeoutPromise]);
      // Timeout (or unreachable gateway) → upstream_unavailable, carrying no status.
      if (res === TIMEOUT) {
        throw new AppError("upstream_unavailable");
      }
      const response = res as Response;
      if (!response.ok) {
        // Attach the status so the retry layer can decide on 429/5xx.
        throw new UpstreamError(response.status);
      }
      try {
        return await response.json();
      } catch {
        throw new AppError("upstream_unavailable");
      }
    } finally {
      clearTimeout(timer!);
    }
  }

  /**
   * Issue a Trading API POST with the 8s timeout and, for idempotent calls only,
   * up to 2 jittered backoff retries on 429/5xx. `/swap` and any submitted tx are
   * never retried, eliminating double-submission on the money path (spec §5.9).
   */
  async function requestWithPolicy(
    path: string,
    body: unknown,
    opts: { retryable: boolean },
  ): Promise<unknown> {
    for (let retry = 0; ; retry++) {
      try {
        return await attempt(path, body);
      } catch (err) {
        const canRetry =
          opts.retryable &&
          retry < RETRY_BASE_MS.length &&
          err instanceof UpstreamError &&
          err.retryable;
        if (!canRetry) {
          // Never leak UpstreamError past the boundary — collapse to the public code.
          throw err instanceof UpstreamError
            ? new AppError("upstream_unavailable")
            : err;
        }
        await sleep(backoffDelay(RETRY_BASE_MS[retry]));
      }
    }
  }

  return {
    async checkApproval(i) {
      return (await requestWithPolicy(
        "/check_approval",
        {
          walletAddress: i.walletAddress,
          token: i.token,
          amount: i.amount,
          chainId: MAINNET_CHAIN_ID,
        },
        { retryable: true },
      )) as { approval: unknown | null };
    },

    async getQuote(i) {
      const { tokenIn, tokenOut } = tokensFor(i.direction);
      const response = (await requestWithPolicy(
        "/quote",
        {
          type: "EXACT_INPUT",
          tokenIn,
          tokenOut,
          tokenInChainId: MAINNET_CHAIN_ID,
          tokenOutChainId: MAINNET_CHAIN_ID,
          amount: i.amount,
          swapper: i.swapper,
          slippageTolerance: i.slippageTolerancePct,
          routingPreference: "CLASSIC",
        },
        { retryable: true },
      )) as { routing: string };
      assertClassicFamilyRouting(response);
      return response;
    },

    async buildSwap(q) {
      const { permitData, permitTransaction, ...cleanQuote } = q;
      // `/swap` is the money path: never retried — no double-submission risk.
      const response = (await requestWithPolicy("/swap", cleanQuote, {
        retryable: false,
      })) as {
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
