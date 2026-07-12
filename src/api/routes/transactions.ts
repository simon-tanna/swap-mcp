import { Hono } from "hono";
import { z } from "zod";

import type { AuthProps } from "../../auth/guards";
import { AppError } from "../../errors";
import type { TransactionsRepository } from "../../repository/transactions";
import { guardedRoute } from "./guardedRoute";

/**
 * Query-param schema for `list`, mirroring `listTransactionsInputShape` from
 * `src/mcp/tools/listTransactions.ts`. `limit` is coerced from its string query
 * value and rejected here only if non-numeric/non-integer/non-positive garbage
 * (→ `invalid_input` → 400) — the repository stays the single source of truth
 * for the 1-100 CAP, so this schema deliberately does NOT clamp the value.
 */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().optional(),
  status: z.enum(["pending", "submitted", "confirmed", "failed"]).optional(),
});

/** REST dep surface this route needs: the transactions repository. */
export type TransactionsRouteDeps = {
  /** The canonical MCP URI every token's audience must match (fail-closed). */
  canonicalMcpUri: string;
  repo: TransactionsRepository;
};

/**
 * `GET /api/transactions` and `GET /api/transactions/:id`: read-scope REST
 * mirrors of MCP `list_transactions`/`get_transaction`. Validated query params
 * (`limit`/`cursor`/`status`) pass through to the repository — same as the MCP
 * tool — so the repo remains the single source of truth for the 1-100 limit cap
 * and cursor tamper rejection (`AppError("invalid_input")`). Non-numeric garbage
 * in `limit` is rejected before the repo so Drizzle never sees `.limit(NaN)`.
 */
export function createTransactionsRoute(
  deps: TransactionsRouteDeps,
): Hono<{ Variables: { props: AuthProps } }> {
  const app = new Hono<{ Variables: { props: AuthProps } }>();

  app.get("/transactions", (c) =>
    guardedRoute(
      c,
      { scope: "swap:read", canonicalMcpUri: deps.canonicalMcpUri },
      async () => {
        const parsed = listQuerySchema.safeParse(c.req.query());
        if (!parsed.success) {
          throw new AppError("invalid_input");
        }
        const { limit, cursor, status } = parsed.data;
        const page = await deps.repo.list({
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor }),
          ...(status !== undefined && { status }),
        });
        return c.json({ rows: page.rows, nextCursor: page.nextCursor });
      },
    ),
  );

  app.get("/transactions/:id", (c) =>
    guardedRoute(
      c,
      { scope: "swap:read", canonicalMcpUri: deps.canonicalMcpUri },
      async () => {
        const row = await deps.repo.findById(c.req.param("id"));
        if (!row) {
          throw new AppError("not_found");
        }
        return c.json({ ...row });
      },
    ),
  );

  return app;
}
