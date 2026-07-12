import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { swapSelectSchema } from "../../db/schema";
import type { ToolDeps } from "./deps";
import { guarded } from "./guarded";

/**
 * Bare Zod v4 raw shape for `list_transactions` (plain object, not a
 * `z.object`). All fields are optional; `limit` is forwarded UNMODIFIED so the
 * repository (single source of truth) applies the 1–100 cap.
 */
export const listTransactionsInputShape = {
  limit: z
    .number()
    .int()
    .optional()
    .describe(
      "Max rows to return (1–100, default 20). Forwarded unmodified; capped server-side by the repository.",
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque pagination token from a previous response's nextCursor. Omit for the first page.",
    ),
  status: z
    .enum(["pending", "submitted", "confirmed", "failed"])
    .optional()
    .describe("Filter by lifecycle state."),
} as const;

/**
 * Bare Zod v4 raw shape for the typed output: a page of full rows plus the
 * `nextCursor` (null on the last page). Each row is validated against the
 * Drizzle `swapSelectSchema` so the row contract can't drift from the table.
 * Exported for the shape contract test.
 */
export const listTransactionsOutputShape = {
  rows: z.array(swapSelectSchema),
  nextCursor: z.string().nullable(),
} as const;

/**
 * Register `list_transactions`: return a newest-first page of swap rows plus a
 * `nextCursor`. Requires `swap:read`; audience + scope are enforced on every
 * call. `limit`/`cursor`/`status` pass straight through to the repository — the
 * repo caps `limit` and rejects tampered cursors with `invalid_input`.
 */
export function registerListTransactions(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "list_transactions",
    {
      description:
        "List swap transactions newest-first with cursor pagination. Returns a page of " +
        "rows plus a nextCursor (null on the last page); optionally filter by status. " +
        "Read-only. To fetch one known swap by id, use get_transaction.",
      inputSchema: listTransactionsInputShape,
      outputSchema: listTransactionsOutputShape,
      annotations: {
        title: "List swap transactions",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) =>
      guarded(deps, "swap:read", async () => {
        const page = await deps.repo.list({
          ...(args.limit !== undefined && { limit: args.limit }),
          ...(args.cursor !== undefined && { cursor: args.cursor }),
          ...(args.status !== undefined && { status: args.status }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(page, null, 2) }],
          structuredContent: { rows: page.rows, nextCursor: page.nextCursor },
        };
      }),
  );
}
