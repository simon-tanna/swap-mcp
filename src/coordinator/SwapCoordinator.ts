import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { createTradingApiClient } from "../engine/tradingApiClient";
import { createViemSigner } from "../engine/viemSigner";
import { validateEnv } from "../env";
import { log } from "../log";
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
 * T15 signer design). Clients are per-request by construction (T15 factory), so
 * building them once per DO instance preserves that isolation guarantee.
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
 * Durable Object coordinating a single swap's lifecycle: it delegates to the
 * T17 `executeSwap`, whose eager D1 writes advance the row pending→submitted→
 * confirmed/failed before the RPC returns.
 */
export class SwapCoordinator extends DurableObject<CloudflareBindings> {
  #deps?: SwapServiceDeps;

  /**
   * Engine deps for `executeSwap`. Lazily built from `this.env` on first read
   * (per-request clients via the T15 factory) and injectable in tests by
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
   * T17 service (which owns the eager D1 lifecycle writes) and emits a single
   * structured observability log.
   *
   * Major-5 safe logging: the log carries ONLY allowlisted, non-secret fields
   * from the returned `SwapResult` plus the input direction — never the raw
   * error, `err.message`, or any secret-accessor return. Redaction lives here on
   * the coordinator's own branch rather than relying on caller convention,
   * because `log()`'s hex scrub cannot catch a non-`0x` leak (e.g. an rpc URL);
   * the only safe rule is to never pass raw error text to the log at all.
   */
  async executeSwap(
    params: ExecuteSwapInput & { userId: string },
  ): Promise<SwapResult> {
    try {
      const result = await executeSwap(this.deps, params);
      log(result.status === "failed" ? "error" : "info", {
        event: "executeSwap",
        transactionId: result.transactionId,
        status: result.status,
        result: result.result,
        errorCode: result.errorCode,
        direction: params.direction,
      });
      return result;
    } catch {
      // `executeSwap` catches internally and returns a `SwapResult`, so an
      // unexpected throw here is a defect. Log only allowlisted fields — never
      // the caught error object — and return a safe failed result.
      log("error", {
        event: "executeSwap",
        status: "error",
        errorCode: "internal",
        direction: params.direction,
      });
      throw new Error("executeSwap failed unexpectedly");
    }
  }
}
