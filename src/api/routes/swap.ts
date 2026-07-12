import { Hono } from "hono";
import { z } from "zod";

import type { AuthProps } from "../../auth/guards";
import { AppError } from "../../errors";
import type { ExecuteSwapInput } from "../../services/rails";
import type { SwapResult } from "../../services/swapService";
import { guardedRoute } from "./guardedRoute";

/**
 * Mirrors the MCP `execute_swap` input shape exactly. Deliberately does NOT
 * accept `userId` — the caller's identity comes from `props.userId` only,
 * never from the request body.
 */
const swapInputSchema = z.object({
  direction: z.enum(["ETH_TO_USDC", "USDC_TO_ETH"]),
  amountIn: z.string(),
  expectedAmountOut: z.string().optional(),
  slippageTolerancePct: z.number().optional(),
  deadlineSeconds: z.number().optional(),
});

/** REST dep surface this route needs: the coordinator's `executeSwap`. */
export type SwapRouteDeps = {
  /** The canonical MCP URI every token's audience must match (fail-closed). */
  canonicalMcpUri: string;
  coordinator: {
    executeSwap(p: ExecuteSwapInput & { userId: string }): Promise<SwapResult>;
  };
};

/**
 * `POST /api/swap`: write-scope REST mirror of MCP `execute_swap`. Gates
 * `swap:write` BEFORE the coordinator is ever reached (fail-closed), forwards
 * optional fields only when present (mirrors `executeSwap.ts`'s
 * `...(x !== undefined && {x})` pattern — omitted keys are literally absent),
 * and returns the `SwapResult` payload unchanged, including a
 * `{ status: "submitted", result: "timed_out" }` pass-through.
 */
export function createSwapRoute(
  deps: SwapRouteDeps,
): Hono<{ Variables: { props: AuthProps } }> {
  const app = new Hono<{ Variables: { props: AuthProps } }>();

  app.post("/swap", (c) =>
    guardedRoute(
      c,
      { scope: "swap:write", canonicalMcpUri: deps.canonicalMcpUri },
      async (props) => {
        const parsed = swapInputSchema.safeParse(await c.req.json());
        if (!parsed.success) {
          throw new AppError("invalid_input");
        }
        const args = parsed.data;
        const result = await deps.coordinator.executeSwap({
          direction: args.direction,
          amountIn: args.amountIn,
          ...(args.expectedAmountOut !== undefined && {
            expectedAmountOut: args.expectedAmountOut,
          }),
          ...(args.slippageTolerancePct !== undefined && {
            slippageTolerancePct: args.slippageTolerancePct,
          }),
          ...(args.deadlineSeconds !== undefined && {
            deadlineSeconds: args.deadlineSeconds,
          }),
          userId: props.userId,
        });
        return c.json({ ...result });
      },
    ),
  );

  return app;
}
