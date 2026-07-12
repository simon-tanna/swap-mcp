import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { drizzle } from "drizzle-orm/d1";

import type { AuthProps } from "../auth/guards";
import { SINGLE_USER_ID } from "../auth/guards";
import * as schema from "../db/schema";
import { createTradingApiClient } from "../engine/tradingApiClient";
import { validateEnv } from "../env";
import { createTransactionsRepository } from "../repository/transactions";
import { getQuote } from "../services/swapService";
import { registerExecuteSwap } from "./tools/executeSwap";
import { registerGetQuote } from "./tools/getQuote";
import { registerGetTransaction } from "./tools/getTransaction";
import { registerListTransactions } from "./tools/listTransactions";
import type { ToolDeps } from "./tools/deps";

/**
 * The remote MCP server as an `McpAgent` Durable Object. It owns the four swap
 * tools and the request-invariant deps they share; per-request auth arrives via
 * `this.props` (set by the OAuth-provider transport before each call).
 *
 * `McpAgent` IS a SQLite-backed Durable Object — it persists MCP session/transport
 * state in DO storage — so the binding must be declared as a `new_sqlite_classes`
 * migration and the binding NAME must equal the class name (`SwapMcpAgent`) for
 * `McpAgent.serve()` to route to it.
 */
export class SwapMcpAgent extends McpAgent<
  CloudflareBindings,
  unknown,
  AuthProps
> {
  // `server` is an abstract property on McpAgent; the SDK connects its transport
  // to this instance, so tool registration in `init()` targets the live server.
  server = new McpServer(
    { name: "swap-mcp", version: "1.0.0" },
    {
      instructions:
        "Executes ETH↔USDC swaps via Uniswap. All token amounts are integer " +
        "base units — wei for ETH (1 ETH = 1e18), 6-decimal for USDC (1 USDC = 1e6). " +
        "Typical flow: price a swap with get_quote, then execute_swap using the quoted " +
        "output as expectedAmountOut; track results with list_transactions and get_transaction.",
    },
  );

  /**
   * Build the request-invariant deps once per DO instance and register all four
   * tools onto `this.server`. Called by the SDK exactly once per instance boot.
   *
   * `getProps` is a LIVE thunk `() => this.props` — never `this.props` captured
   * here — so every tool call observes the props the transport set for THAT
   * request. Audience is enforced per-registrar (each tool's `guarded()` calls
   * `assertAudience(getProps(), canonicalMcpUri)`), so wiring both fields is all
   * this class does for the fail-closed audience gate.
   */
  async init(): Promise<void> {
    const v = validateEnv(this.env);
    const db = drizzle(this.env.DB, { schema });
    const repo = createTransactionsRepository(db);
    const tradingApi = createTradingApiClient({
      baseUrl: v.tradingApiBaseUrl,
      getApiKey: v.getUniswapApiKey,
    });

    const deps: ToolDeps = {
      // Live read of the mutable `this.props`; not captured at init time.
      getProps: () => this.props as AuthProps,
      canonicalMcpUri: v.canonicalMcpUri,
      // `getQuote` bound to its engine deps so tools invoke it with caller input
      // only — they never construct or hold a TradingApiClient.
      service: {
        getQuote: (input) => getQuote({ tradingApi }, input),
      },
      // Route the write path to the single-user SwapCoordinator DO. One wallet ⇒
      // one coordinator instance, keyed by the stable single-user id.
      coordinator: {
        executeSwap: (p) => {
          const coordinatorId =
            this.env.SWAP_COORDINATOR.idFromName(SINGLE_USER_ID);
          return this.env.SWAP_COORDINATOR.get(coordinatorId).executeSwap(p);
        },
      },
      repo,
    };

    registerGetQuote(this.server, deps);
    registerExecuteSwap(this.server, deps);
    registerListTransactions(this.server, deps);
    registerGetTransaction(this.server, deps);
  }
}
