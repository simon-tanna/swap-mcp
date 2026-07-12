import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AppError } from "../../errors";
import { swapSelectSchema } from "../../db/schema";
import type { ToolDeps } from "./deps";
import { guarded } from "./guarded";

/** Bare Zod v4 raw shape for `get_transaction` (plain object, not a `z.object`). */
export const getTransactionInputShape = {
  id: z
    .string()
    .min(1)
    .describe(
      "The swap transaction id, as returned by execute_swap or list_transactions.",
    ),
} as const;

/**
 * Bare Zod v4 raw shape for the typed output: the raw `.shape` of the Drizzle
 * `swapSelectSchema`, so the row contract can't drift from the table. Nullable
 * columns are `.nullable()` (drizzle-zod), matching the explicit `null`s a row
 * carries. Exported for the shape contract test.
 */
export const getTransactionOutputShape = swapSelectSchema.shape;

/**
 * Register `get_transaction`: look up one swap row by id and surface its live
 * state. Requires `swap:read`; audience + scope are enforced on every call.
 * An unknown id maps to a `not_found` error envelope.
 */
export function registerGetTransaction(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "get_transaction",
    {
      description:
        "Look up one swap by its id (as returned by execute_swap or list_transactions) " +
        "and return its current lifecycle state, amounts, tx hash, and error code. " +
        "Read-only. Returns not_found if the id is unknown. To browse without an id, " +
        "use list_transactions.",
      inputSchema: getTransactionInputShape,
      outputSchema: getTransactionOutputShape,
      annotations: {
        title: "Get swap transaction",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) =>
      guarded(deps, "swap:read", async () => {
        const row = await deps.repo.findById(args.id);
        if (!row) {
          throw new AppError("not_found");
        }
        return {
          content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
          structuredContent: { ...row },
        };
      }),
  );
}
