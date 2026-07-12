import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolDeps } from "./deps";
import { guarded } from "./guarded";

/**
 * Bare Zod v4 raw shape for `list_transactions` (plain object, not a
 * `z.object`). All fields are optional; `limit` is forwarded UNMODIFIED so the
 * repository (single source of truth) applies the 1–100 cap.
 */
export const listTransactionsInputShape = {
  limit: z.number().int().optional(),
  cursor: z.string().optional(),
  status: z.enum(["pending", "submitted", "confirmed", "failed"]).optional(),
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
      description: "List swap transactions newest-first with cursor paging.",
      inputSchema: listTransactionsInputShape,
    },
    (args) =>
      guarded(deps, "swap:read", async () => {
        const page = await deps.repo.list({
          ...(args.limit !== undefined && { limit: args.limit }),
          ...(args.cursor !== undefined && { cursor: args.cursor }),
          ...(args.status !== undefined && { status: args.status }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(page) }],
          structuredContent: { rows: page.rows, nextCursor: page.nextCursor },
        };
      }),
  );
}
