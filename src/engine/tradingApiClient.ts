import { isAddress, isHex } from "viem";
import { z } from "zod";
import { AppError } from "../errors";
import { log } from "../log";
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
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export type SwapDirection = "ETH_TO_USDC" | "USDC_TO_ETH";

/** Inputs for a `/quote` request; token addresses are derived from `direction`. */
export type QuoteInput = {
  direction: SwapDirection;
  amount: string;
  swapper: string;
  slippageTolerancePct: number;
};

/**
 * Single source of truth for CLASSIC-family routings. Feeds the `/quote` schema
 * enum, the `CLASSIC_FAMILY` set, and (via `z.infer`) the `routing` literal type,
 * so the accepted routings can never drift across those three uses.
 */
const CLASSIC_ROUTINGS = ["CLASSIC", "WRAP", "UNWRAP"] as const;

/**
 * On-chain Uniswap protocols only (no `UNISWAPX_V2`/`UNISWAPX_V3`). Restricting
 * `/quote`'s `protocols` to these forces a CLASSIC-family routing so `viemSigner`
 * can sign and submit the returned calldata — the `routingPreference` value
 * `"CLASSIC"` was REMOVED from the API (only `BEST_PRICE`/`FASTEST` remain), so the
 * classic-only intent now lives here in `protocols`, not in `routingPreference`.
 */
const CLASSIC_PROTOCOLS = ["V2", "V3", "V4"] as const;

/**
 * `/quote` boundary schema. Loose at every re-forwarded level so `buildSwap`'s
 * re-spread into `/swap` keeps all upstream fields (a `z.object` anywhere in this
 * subtree would strip that level's extras and break the `/swap` contract). Only
 * `routing` (gated to CLASSIC-family) and `quote.output.amount` are required; any
 * other routing fails the enum and collapses to `upstream_unavailable`.
 */
const classicQuoteSchema = z.looseObject({
  routing: z.enum(CLASSIC_ROUTINGS),
  quote: z.looseObject({
    output: z.looseObject({ amount: z.string() }),
  }),
  permitData: z.unknown().nullish(),
  permitTransaction: z.unknown().nullish(),
});

/**
 * `/swap` boundary schema. Default strip is fine — `buildSwap` builds a fresh
 * `SwapTx` from exactly these five fields and re-forwards nothing else.
 */
const swapResponseSchema = z.object({
  swap: z.object({
    to: z.string(),
    data: z.string(),
    value: z.string(),
    chainId: z.number(),
    gasLimit: z.string(),
  }),
});

/**
 * `/check_approval` boundary schema. The `approval` value stays opaque, but the
 * key is required and must be an object or `null` — a missing key or a
 * non-object/non-null value fails closed rather than passing as "approved".
 */
const checkApprovalSchema = z.object({
  approval: z.union([z.looseObject({}), z.null()]),
});

export type ClassicQuoteResponse = z.infer<typeof classicQuoteSchema>;

/** The ready-to-sign swap transaction unwrapped from the `/swap` `{ swap }` envelope. */
export type SwapTx = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  gasLimit: string;
};

export interface TradingApiClient {
  checkApproval(i: {
    token: string;
    amount: string;
    walletAddress: string;
  }): Promise<{ approval: unknown | null }>;
  getQuote(i: QuoteInput): Promise<ClassicQuoteResponse>;
  buildSwap(q: ClassicQuoteResponse): Promise<SwapTx>;
}

const CLASSIC_FAMILY = new Set<string>(CLASSIC_ROUTINGS);

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

function tokensFor(direction: SwapDirection): {
  tokenIn: string;
  tokenOut: string;
} {
  return direction === "ETH_TO_USDC"
    ? { tokenIn: NATIVE_ETH_SENTINEL, tokenOut: USDC_ADDRESS }
    : { tokenIn: USDC_ADDRESS, tokenOut: NATIVE_ETH_SENTINEL };
}

/** Per-Trading-API-call timeout: a slower call maps to `upstream_unavailable`. */
const CALL_TIMEOUT_MS = 8000;

/** Backoff bases before retry 1 and retry 2; length also caps retries at 2. */
const RETRY_BASE_MS = [250, 500] as const;

/** A distinct sentinel used to win the timeout race against a hung `fetch`. */
const TIMEOUT = Symbol("trading-api-timeout");

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
        // The public code stays opaque; the log preserves which call timed out so
        // an outage is diagnosable from `wrangler tail` (no status, no body).
        log("warn", { event: "trading_api_timeout", path });
        throw new AppError("upstream_unavailable");
      }
      const response = res as Response;
      if (!response.ok) {
        // Surface the real upstream status (401/400/429/5xx) that the boundary
        // otherwise collapses into `upstream_unavailable`. Fires on every attempt,
        // so retried 429/5xx calls are visible. The api key lives only in headers,
        // never in these fields; `log`'s redaction also scrubs any long hex.
        // A bounded body snippet names the offending field on a 4xx (the status
        // alone can't); the read is guarded so a body failure can't mask the error.
        let detail: string | undefined;
        try {
          detail = (await response.text()).slice(0, 500);
        } catch {
          detail = undefined;
        }
        log("warn", {
          event: "trading_api_upstream_error",
          path,
          status: response.status,
          ...(detail !== undefined && { detail }),
        });
        // Attach the status so the retry layer can decide on 429/5xx.
        throw new UpstreamError(response.status);
      }
      try {
        return await response.json();
      } catch {
        log("warn", {
          event: "trading_api_non_json",
          path,
          status: response.status,
        });
        throw new AppError("upstream_unavailable");
      }
    } finally {
      clearTimeout(timer!);
    }
  }

  /**
   * Issue a Trading API POST with the 8s timeout and, for idempotent calls only,
   * up to 2 jittered backoff retries on 429/5xx. `/swap` and any submitted tx are
   * never retried, eliminating double-submission on the money path.
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
      const raw = await requestWithPolicy(
        "/check_approval",
        {
          walletAddress: i.walletAddress,
          token: i.token,
          amount: i.amount,
          chainId: MAINNET_CHAIN_ID,
        },
        { retryable: true },
      );
      const parsed = checkApprovalSchema.safeParse(raw);
      if (!parsed.success) {
        log("warn", {
          event: "schema_reject",
          path: "/check_approval",
          issues: parsed.error.issues,
        });
        throw new AppError("upstream_unavailable");
      }
      return { approval: parsed.data.approval };
    },

    async getQuote(i) {
      const { tokenIn, tokenOut } = tokensFor(i.direction);
      const raw = await requestWithPolicy(
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
          // Classic on-chain routing is selected via `protocols` (V2/V3/V4 only),
          // NOT `routingPreference` — the API sunset the `"CLASSIC"` preference and
          // now rejects it with a 400. `BEST_PRICE` picks the best price across the
          // permitted classic protocols (it is also the API default).
          protocols: CLASSIC_PROTOCOLS,
          routingPreference: "BEST_PRICE",
        },
        { retryable: true },
      );
      // The schema's routing enum enforces the CLASSIC-family gate (a non-CLASSIC
      // routing fails the enum), so a separate assertClassicFamilyRouting call
      // here would be redundant.
      const parsed = classicQuoteSchema.safeParse(raw);
      if (!parsed.success) {
        // The most likely "healthy 200 that we still reject": a routing outside
        // the CLASSIC family (e.g. DUTCH_V2 slipping past routingPreference), or a
        // shape drift in `quote.output.amount`. Logging the received `routing`
        // turns that from a silent `upstream_unavailable` into a one-line diagnosis.
        log("warn", {
          event: "quote_schema_reject",
          path: "/quote",
          routing: (raw as { routing?: unknown } | null)?.routing,
          issues: parsed.error.issues,
        });
        throw new AppError("upstream_unavailable");
      }
      return parsed.data;
    },

    async buildSwap(q) {
      const { permitData, permitTransaction, ...cleanQuote } = q;
      // `/swap` is the money path: never retried — no double-submission risk.
      const raw = await requestWithPolicy("/swap", cleanQuote, {
        retryable: false,
      });
      const parsed = swapResponseSchema.safeParse(raw);
      if (!parsed.success) {
        log("warn", {
          event: "schema_reject",
          path: "/swap",
          issues: parsed.error.issues,
        });
        throw new AppError("upstream_unavailable");
      }
      const { to, data, value, chainId, gasLimit } = parsed.data.swap;
      // Pre-broadcast validation: the schema only proves these are strings. An
      // expired/failed quote can return empty or non-hex `data` (or a junk `to`)
      // that would revert on-chain and burn gas once signed and submitted. Reject
      // it here at the boundary so no reverting tx is ever built. (`from` is not in
      // the response schema, so only `to` is validated.)
      if (data === "" || data === "0x" || !isHex(data) || !isAddress(to)) {
        log("warn", {
          event: "swap_response_invalid",
          path: "/swap",
          emptyData: data === "" || data === "0x",
        });
        throw new AppError("upstream_unavailable");
      }
      return { to, data, value, chainId, gasLimit };
    },
  };
}
