import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";

import type { AuthProps } from "../auth/guards";
import { SINGLE_USER_ID } from "../auth/guards";
import * as schema from "../db/schema";
import { createTradingApiClient } from "../engine/tradingApiClient";
import { validateEnv } from "../env";
import { createTransactionsRepository } from "../repository/transactions";
import { getQuote } from "../services/swapService";
import { propsAdapter } from "./middleware/props";
import { createQuoteRoute, type QuoteRouteDeps } from "./routes/quote";
import { createSwapRoute, type SwapRouteDeps } from "./routes/swap";
import {
  createTransactionsRoute,
  type TransactionsRouteDeps,
} from "./routes/transactions";

/**
 * Everything the four REST routes need, injected so they stay pure and
 * unit-testable — the exact same shapes `ToolDeps` uses for the MCP tools
 * (`service.getQuote` bound to engine deps, `coordinator.executeSwap` routed
 * through the Durable Object, and the shared `repo`), minus the MCP-only
 * `getProps`/`canonicalMcpUri` fields: REST identity comes from `propsAdapter`
 * reading `c.executionCtx.props`, not a tool-registration thunk.
 */
export type ApiDeps = QuoteRouteDeps & SwapRouteDeps & TransactionsRouteDeps;

/**
 * Build the REST mirror app. `propsAdapter` is mounted FIRST so every route
 * reads identity via `c.get("props")` only — routes never touch
 * `c.executionCtx` directly. Each route already wraps its own body so any
 * thrown error (including `AppError`) resolves through `errorResponse`,
 * giving a uniform HTTP status and curated, non-leaking body.
 */
export function createApiApp(
  deps: ApiDeps,
): Hono<{ Variables: { props: AuthProps } }> {
  const app = new Hono<{ Variables: { props: AuthProps } }>();

  app.use("*", propsAdapter);
  app.route("/api", createQuoteRoute(deps));
  app.route("/api", createSwapRoute(deps));
  app.route("/api", createTransactionsRoute(deps));

  return app;
}

/**
 * Build the production `ApiDeps` from `env`, used by the T31 wiring layer.
 * Mirrors `SwapMcpAgent.init()` exactly: `service.getQuote` bound to the same
 * trading-API client, `coordinator.executeSwap` routed to the single-user
 * `SWAP_COORDINATOR` Durable Object by name, and `repo` built the same way.
 * There is no additional secret-bound construction needed here — every dep
 * the REST routes touch is already request-time-safe the way the MCP layer
 * builds it, so this does not invent a new construction path.
 */
export function buildDefaultApiDeps(env: CloudflareBindings): ApiDeps {
  const v = validateEnv(env);
  const db = drizzle(env.DB, { schema });
  const repo = createTransactionsRepository(db);
  const tradingApi = createTradingApiClient({
    baseUrl: v.tradingApiBaseUrl,
    getApiKey: v.getUniswapApiKey,
  });

  return {
    // Wired exactly as SwapMcpAgent.init() sets it, from the validated env.
    canonicalMcpUri: v.canonicalMcpUri,
    service: {
      getQuote: (input) => getQuote({ tradingApi }, input),
    },
    coordinator: {
      executeSwap: (p) => {
        const coordinatorId = env.SWAP_COORDINATOR.idFromName(SINGLE_USER_ID);
        return env.SWAP_COORDINATOR.get(coordinatorId).executeSwap(p);
      },
    },
    repo,
  };
}
