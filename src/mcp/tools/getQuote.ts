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
  direction: z
    .enum(["ETH_TO_USDC", "USDC_TO_ETH"])
    .describe(
      "Swap direction. ETH_TO_USDC sells ETH for USDC; USDC_TO_ETH sells USDC for ETH.",
    ),
  amountIn: z
    .string()
    .regex(/^\d+$/)
    .describe(
      "Input amount in BASE UNITS as an integer string — wei for ETH (1 ETH = 1000000000000000000), 6-decimal for USDC (1 USDC = 1000000). Not a decimal like '1.5'.",
    ),
} as const;

/**
 * Bare Zod v4 raw shape for the typed output, mirroring `QuoteResult`
 * (`services/swapService.ts`). Declared as `outputSchema` so clients get a
 * validatable contract; the SDK validates success `structuredContent` against
 * it (error envelopes are `isError`-exempt). Exported for the shape contract test.
 */
export const getQuoteOutputShape = {
  direction: z.enum(["ETH_TO_USDC", "USDC_TO_ETH"]),
  amountIn: z.string(),
  quotedAmountOut: z.string(),
  price: z.string(),
  slippageTolerancePct: z.number(),
  createdAt: z.number(),
  freshUntil: z.number(),
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
        "Fetch a price quote for an ETH↔USDC swap. Returns the expected output " +
        "(quotedAmountOut, in base units), the decimal-adjusted price, the applied " +
        "slippage tolerance, and a freshness window (freshUntil). Read-only — no funds " +
        "move. quotedAmountOut can be supplied to execute_swap as expectedAmountOut.",
      inputSchema: getQuoteInputShape,
      outputSchema: getQuoteOutputShape,
      annotations: {
        title: "Get swap quote",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) =>
      guarded(deps, "swap:read", async () => {
        const quote = await deps.service.getQuote({
          direction: args.direction,
          amountIn: args.amountIn,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(quote, null, 2) }],
          structuredContent: { ...quote },
        };
      }),
  );
}
