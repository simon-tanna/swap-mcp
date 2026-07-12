import { and, desc, eq, lt, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { swaps } from "../db/schema";
import type {
  NewSwapRow,
  SwapDirection,
  SwapRow,
  SwapStatus,
} from "../db/schema";
import type { ErrorCode } from "../errors";
import { decodeCursor, encodeCursor } from "./cursor";

export type { SwapRow, SwapStatus } from "../db/schema";

/** Caller-supplied fields for a new pending swap; the repo fills id/status/createdAt and nulls. */
export type NewSwapInput = Omit<
  NewSwapRow,
  | "id"
  | "status"
  | "createdAt"
  | "txHash"
  | "actualAmountOut"
  | "errorCode"
  | "gasUsed"
  | "submittedAt"
  | "settledAt"
> & { direction: SwapDirection };

/** Persistence port for swap lifecycle rows: insert, state transitions, lookup, and paged listing. */
export interface TransactionsRepository {
  insertPending(row: NewSwapInput): Promise<string>;
  markSubmitted(id: string, txHash: string): Promise<void>;
  markConfirmed(
    id: string,
    r: { actualAmountOut: string; gasUsed: string },
  ): Promise<void>;
  markFailed(
    id: string,
    errorCode: ErrorCode,
    opts?: { txHash?: string },
  ): Promise<void>;
  findById(id: string): Promise<SwapRow | undefined>;
  list(q: {
    limit?: number;
    cursor?: string;
    status?: SwapStatus;
  }): Promise<{ rows: SwapRow[]; nextCursor: string | null }>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Construct a TransactionsRepository backed by the given drizzle D1 client. */
export function createTransactionsRepository(
  db: DrizzleD1Database<typeof schema>,
): TransactionsRepository {
  return {
    async insertPending(row) {
      const id = crypto.randomUUID();
      await db.insert(swaps).values({
        id,
        userId: row.userId,
        direction: row.direction,
        amountIn: row.amountIn,
        expectedAmountOut: row.expectedAmountOut ?? null,
        quotedAmountOut: row.quotedAmountOut,
        slippageTolerancePct: row.slippageTolerancePct,
        deadlineSeconds: row.deadlineSeconds,
        status: "pending",
        createdAt: Date.now(),
      });
      return id;
    },

    async markSubmitted(id, txHash) {
      await db
        .update(swaps)
        .set({ status: "submitted", txHash, submittedAt: Date.now() })
        .where(eq(swaps.id, id));
    },

    async markConfirmed(id, r) {
      await db
        .update(swaps)
        .set({
          status: "confirmed",
          actualAmountOut: r.actualAmountOut,
          gasUsed: r.gasUsed,
          settledAt: Date.now(),
        })
        .where(eq(swaps.id, id));
    },

    async markFailed(id, errorCode, opts) {
      await db
        .update(swaps)
        .set({
          status: "failed",
          errorCode,
          txHash: opts?.txHash ?? null,
          settledAt: Date.now(),
        })
        .where(eq(swaps.id, id));
    },

    async findById(id) {
      return db.query.swaps.findFirst({ where: eq(swaps.id, id) });
    },

    async list(q) {
      const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

      const statusFilter = q.status ? eq(swaps.status, q.status) : undefined;

      let cursorFilter;
      if (q.cursor !== undefined) {
        const c = decodeCursor(q.cursor);
        cursorFilter = or(
          lt(swaps.createdAt, c.createdAt),
          and(eq(swaps.createdAt, c.createdAt), lt(swaps.id, c.id)),
        );
      }

      const where = and(statusFilter, cursorFilter);

      const found = await db.query.swaps.findMany({
        where,
        orderBy: [desc(swaps.createdAt), desc(swaps.id)],
        limit: limit + 1,
      });

      const hasMore = found.length > limit;
      const rows = hasMore ? found.slice(0, limit) : found;
      const last = rows[rows.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null;

      return { rows, nextCursor };
    },
  };
}
