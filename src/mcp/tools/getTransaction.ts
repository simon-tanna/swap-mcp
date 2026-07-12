import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AppError } from "../../errors";
import type { ToolDeps } from "./deps";
import { guarded } from "./guarded";

/** Bare Zod v4 raw shape for `get_transaction` (plain object, not a `z.object`). */
export const getTransactionInputShape = {
  id: z.string(),
} as const;

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
      description: "Look up a single swap transaction by id.",
      inputSchema: getTransactionInputShape,
    },
    (args) =>
      guarded(deps, "swap:read", async () => {
        const row = await deps.repo.findById(args.id);
        if (!row) {
          throw new AppError("not_found");
        }
        return {
          content: [{ type: "text", text: JSON.stringify(row) }],
          structuredContent: { ...row },
        };
      }),
  );
}
