import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolDeps } from "./deps";
import { guarded } from "./guarded";

/**
 * Bare Zod v4 raw shape for `execute_swap` (a plain object of validators, NOT a
 * `z.object(...)` — `registerTool` expects exactly this). Optionals mirror
 * `ExecuteSwapInput`; the enum values match `SwapDirection`. Exported so tests
 * can assert the raw-shape contract.
 */
export const executeSwapInputShape = {
  direction: z.enum(["ETH_TO_USDC", "USDC_TO_ETH"]),
  amountIn: z.string(),
  expectedAmountOut: z.string().optional(),
  slippageTolerancePct: z.number().optional(),
  deadlineSeconds: z.number().optional(),
} as const;

/**
 * Register `execute_swap`: the WRITE/money path. Requires `swap:write`; audience
 * and scope are enforced on every call via {@link guarded}, so both reject
 * fail-closed BEFORE the coordinator is ever reached. Optional fields are
 * forwarded only when present (never re-inserted as `undefined`), plus the
 * caller's `userId`. Any throw from the coordinator — including `AppError` —
 * flows through `guarded`'s catch into a curated error envelope.
 */
export function registerExecuteSwap(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "execute_swap",
    {
      description: "Execute an ETH/USDC swap; requires swap:write.",
      inputSchema: executeSwapInputShape,
    },
    (args) =>
      guarded(deps, "swap:write", async () => {
        const props = deps.getProps();
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
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      }),
  );
}
