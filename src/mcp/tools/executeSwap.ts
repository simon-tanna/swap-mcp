import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ERROR_CODES } from "../../errors";
import type { ToolDeps } from "./deps";
import { guarded } from "./guarded";

/**
 * Bare Zod v4 raw shape for `execute_swap` (a plain object of validators, NOT a
 * `z.object(...)` — `registerTool` expects exactly this). Optionals mirror
 * `ExecuteSwapInput`; the enum values match `SwapDirection`. Exported so tests
 * can assert the raw-shape contract.
 */
export const executeSwapInputShape = {
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
  expectedAmountOut: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe(
      "Minimum acceptable output in base units (the drift floor) — typically get_quote's quotedAmountOut. Omit to skip the floor check.",
    ),
  slippageTolerancePct: z
    .number()
    .gt(0)
    .max(5)
    .optional()
    .describe(
      "Max slippage as a percent, e.g. 0.5 = 0.5%. Range 0 (exclusive) to 5. Defaults to 0.5.",
    ),
  deadlineSeconds: z
    .number()
    .positive()
    .optional()
    .describe(
      "Transaction deadline in seconds from now; must be > 0. Defaults to the server default.",
    ),
} as const;

/**
 * Bare Zod v4 raw shape for the typed output, derived from the `SwapResult`
 * type (`services/swapService.ts`) — NOT a DB row. `status` is the 3-value
 * result set (distinct from the DB row's 4-value status) and `result` is a
 * required discriminator; the rest are `.optional()` to match `SwapResult`'s
 * optionals. Missing/mislabeling `result`/`status` would fail success-path
 * output validation on every swap. Exported for the shape contract test.
 */
export const executeSwapOutputShape = {
  transactionId: z.string(),
  status: z.enum(["confirmed", "failed", "submitted"]),
  result: z.enum(["ok", "timed_out"]),
  txHash: z.string().optional(),
  quotedAmountOut: z.string().optional(),
  actualAmountOut: z.string().optional(),
  gasUsed: z.string().optional(),
  errorCode: z.enum(ERROR_CODES).optional(),
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
      description:
        "Execute an ETH↔USDC swap: signs and broadcasts a real on-chain transaction " +
        "and records it. Amounts are in base units (wei for ETH, 6-decimal for USDC). " +
        "Returns a transactionId, lifecycle status, and txHash once known. Moves funds " +
        "and cannot be undone. The returned transactionId can be looked up with get_transaction.",
      inputSchema: executeSwapInputShape,
      outputSchema: executeSwapOutputShape,
      annotations: {
        title: "Execute swap",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
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
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
        };
      }),
  );
}
