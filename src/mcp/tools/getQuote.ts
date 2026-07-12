import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolDeps } from "./deps";
import { guarded } from "./guarded";

/**
 * Bare Zod v4 raw shape (a plain object of validators, NOT a `z.object(...)`).
 * `registerTool` expects exactly this — wrapping it in `z.object` would break
 * argument inference. Exported so tests can assert the raw-shape contract.
 */
export const getQuoteInputShape = {
  direction: z.enum(["ETH_TO_USDC", "USDC_TO_ETH"]),
  amountIn: z.string(),
} as const;

/**
 * Register `get_quote`: fetch a swapper-agnostic price quote plus a freshness
 * hint. Requires `swap:read`; audience and scope are enforced on every call via
 * {@link guarded}. On success returns the quote as both text and
 * `structuredContent`; any failure resolves as an error envelope.
 */
export function registerGetQuote(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_quote",
    {
      description:
        "Fetch a price quote for an ETH/USDC swap, with a freshness hint.",
      inputSchema: getQuoteInputShape,
    },
    (args) =>
      guarded(deps, "swap:read", async () => {
        const quote = await deps.service.getQuote({
          direction: args.direction,
          amountIn: args.amountIn,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(quote) }],
          structuredContent: { ...quote },
        };
      }),
  );
}
