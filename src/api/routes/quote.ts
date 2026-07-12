import { Hono } from "hono";
import { z } from "zod";

import type { AuthProps } from "../../auth/guards";
import { AppError } from "../../errors";
import type { QuoteResult } from "../../services/swapService";
import type { SwapDirection } from "../../engine/tradingApiClient";
import { guardedRoute } from "./guardedRoute";

/** Mirrors the MCP `get_quote` input shape exactly. */
const quoteInputSchema = z.object({
  direction: z.enum(["ETH_TO_USDC", "USDC_TO_ETH"]),
  amountIn: z.string(),
});

/** REST dep surface this route needs: the same bound-thunk `getQuote` the MCP tools use. */
export type QuoteRouteDeps = {
  /** The canonical MCP URI every token's audience must match (fail-closed). */
  canonicalMcpUri: string;
  service: {
    getQuote: (input: {
      direction: SwapDirection;
      amountIn: string;
    }) => Promise<QuoteResult>;
  };
};

/**
 * `POST /api/quote`: read-scope REST mirror of MCP `get_quote`. Returns the
 * same `QuoteResult` shape as the MCP tool's `structuredContent`, including
 * `quotedAmountOut` reusable verbatim as `execute_swap`'s `expectedAmountOut`.
 */
export function createQuoteRoute(
  deps: QuoteRouteDeps,
): Hono<{ Variables: { props: AuthProps } }> {
  const app = new Hono<{ Variables: { props: AuthProps } }>();

  app.post("/quote", (c) =>
    guardedRoute(
      c,
      { scope: "swap:read", canonicalMcpUri: deps.canonicalMcpUri },
      async () => {
        const parsed = quoteInputSchema.safeParse(await c.req.json());
        if (!parsed.success) {
          throw new AppError("invalid_input");
        }
        const quote = await deps.service.getQuote(parsed.data);
        return c.json({ ...quote });
      },
    ),
  );

  return app;
}
