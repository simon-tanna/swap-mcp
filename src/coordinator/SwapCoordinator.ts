import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { createTradingApiClient } from "../engine/tradingApiClient";
import { createViemSigner } from "../engine/viemSigner";
import { validateEnv } from "../env";
import { log, safeError } from "../log";
import { createTransactionsRepository } from "../repository/transactions";
import type { ExecuteSwapInput } from "../services/rails";
import {
  executeSwap,
  type SwapResult,
  type SwapServiceDeps,
} from "../services/swapService";

/**
 * Build the default engine deps from `env`, storing only accessor closures — the
 * raw private key/rpc-url are never fields on the returned deps or the DO
 * instance, so a `JSON.stringify` snapshot exposes no key material (mirrors the
 * signer design). Clients are per-request by construction, so building them once
 * per DO instance preserves that isolation guarantee.
 */
function createDefaultDeps(env: CloudflareBindings): SwapServiceDeps {
  const v = validateEnv(env);
  const db = drizzle(env.DB, { schema });
  return {
    tradingApi: createTradingApiClient({
      baseUrl: v.tradingApiBaseUrl,
      getApiKey: v.getUniswapApiKey,
    }),
    signer: createViemSigner({
      getPrivateKey: v.getSwapPrivateKey,
      getRpcUrl: v.getEthRpcUrl,
    }),
    repo: createTransactionsRepository(db),
  };
}

/**
 * Durable Object coordinating a single swap's lifecycle: it delegates to
 * `executeSwap`, whose eager D1 writes advance the row pending→submitted→
 * confirmed/failed before the RPC returns.
 */
export class SwapCoordinator extends DurableObject<CloudflareBindings> {
  #deps?: SwapServiceDeps;

  /**
   * Single-flight mutex tail: each `executeSwap` chains its work onto the prior
   * call's settlement, so concurrent calls to the same live instance are fully
   * SERIALIZED — the engine work of call N+1 begins only after call N settles.
   *
   * Mutex-eviction bound: `#tail` is an IN-MEMORY, per-live-instance primitive.
   * It serializes only within one running DO instance and does NOT survive DO
   * eviction/hibernation (a re-instantiated DO starts with a fresh resolved
   * tail). Cross-eviction safety therefore rests NOT on this mutex but on the
   * single-in-flight-swap invariant (one wallet) plus D1 reconciliation of any
   * `submitted`-stranded row — the mutex is a within-instance ordering aid only.
   */
  #tail: Promise<unknown> = Promise.resolve();

  /**
   * Engine deps for `executeSwap`. Lazily built from `this.env` on first read
   * (per-request clients via the factory) and injectable in tests by
   * assigning fakes; the getter never stores raw key material as a field.
   */
  get deps(): SwapServiceDeps {
    return (this.#deps ??= createDefaultDeps(this.env));
  }

  set deps(deps: SwapServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Execute one swap end-to-end and return its terminal result. Delegates to the
   * swap service (which owns the eager D1 lifecycle writes) and emits a single
   * structured observability log.
   *
   * Safe logging: the log carries ONLY allowlisted, non-secret fields
   * from the returned `SwapResult` plus the input direction — never the raw
   * error, `err.message`, or any secret-accessor return. Redaction lives here on
   * the coordinator's own branch rather than relying on caller convention,
   * because `log()`'s hex scrub cannot catch a non-`0x` leak (e.g. an rpc URL);
   * the only safe rule is to never pass raw error text to the log at all.
   */
  async executeSwap(
    params: ExecuteSwapInput & { userId: string },
  ): Promise<SwapResult> {
    const doWork = async (): Promise<SwapResult> => {
      // Resolve engine deps first, in their OWN try: `this.deps` lazily builds
      // the viem signer, whose eager `privateKeyToAccount` throws a RAW error on
      // a malformed `SWAP_PRIVATE_KEY` (and `validateEnv` on bad config). Tagging
      // this `stage:"signer_init"` makes a server MISCONFIG one-glance distinct
      // from a runtime defect — and it throws before any `classify()`, so this is
      // the only place it can be labeled. `safeError` yields a secret-safe
      // identity (constructor name + normalized+scrubbed detail); the raw error
      // is never logged.
      let deps: SwapServiceDeps;
      try {
        deps = this.deps;
      } catch (err) {
        log("error", {
          event: "executeSwap",
          stage: "signer_init",
          status: "error",
          errorCode: "internal",
          direction: params.direction,
          ...safeError(err),
        });
        throw new Error("executeSwap failed unexpectedly");
      }

      try {
        const result = await executeSwap(deps, params);
        log(result.status === "failed" ? "error" : "info", {
          event: "executeSwap",
          transactionId: result.transactionId,
          status: result.status,
          result: result.result,
          errorCode: result.errorCode,
          direction: params.direction,
        });
        return result;
      } catch (err) {
        // `executeSwap` catches internally and returns a `SwapResult`, so an
        // unexpected throw here is a defect (e.g. the pre-quote `insertPending`
        // D1 write, which sits outside the service's try). `safeError` logs a
        // secret-safe identity for it — never the raw error — then a safe result.
        log("error", {
          event: "executeSwap",
          status: "error",
          errorCode: "internal",
          direction: params.direction,
          ...safeError(err),
        });
        throw new Error("executeSwap failed unexpectedly");
      }
    };

    // Chain onto the tail regardless of the prior call's outcome, so a rejection
    // never breaks serialization; the caller still observes THIS run's result.
    // run and #tail intentionally diverge: #tail is the swallowed tail for the
    // next caller's chain; run (returned) is the unswallowed promise THIS caller
    // observes — do not collapse into one expression (it would hide the caller's
    // rejection).
    const run = this.#tail.then(doWork, doWork);
    this.#tail = run.catch(() => {});
    return run;
  }
}
