import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";

/** Persisted lifecycle record for a single swap request (see spec §5.11). */
export const swaps = sqliteTable(
  "swaps",
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    direction: text().notNull(),
    amountIn: text().notNull(),
    expectedAmountOut: text(),
    quotedAmountOut: text().notNull(),
    actualAmountOut: text(),
    slippageTolerancePct: text().notNull(),
    deadlineSeconds: integer().notNull(),
    txHash: text(),
    status: text().notNull(),
    errorCode: text(),
    gasUsed: text(),
    createdAt: integer().notNull(),
    submittedAt: integer(),
    settledAt: integer(),
  },
  (table) => [
    check(
      "direction_check",
      sql`${table.direction} IN ('ETH_TO_USDC','USDC_TO_ETH')`,
    ),
    check(
      "status_check",
      sql`${table.status} IN ('pending','submitted','confirmed','failed')`,
    ),
  ],
);

/** The four terminal-or-transient states a swap row may occupy — single source of truth. */
export const SWAP_STATUS = z.enum([
  "pending",
  "submitted",
  "confirmed",
  "failed",
]);
export type SwapStatus = z.infer<typeof SWAP_STATUS>;

/** The two supported swap directions — single source of truth. */
export const SWAP_DIRECTION = z.enum(["ETH_TO_USDC", "USDC_TO_ETH"]);
export type SwapDirection = z.infer<typeof SWAP_DIRECTION>;

/** Zod schema for a fully-materialized swap row as read back from the database. */
export const swapSelectSchema = createSelectSchema(swaps);

/** Zod schema for inserting a new swap row. */
export const swapInsertSchema = createInsertSchema(swaps, {
  status: SWAP_STATUS,
  direction: SWAP_DIRECTION,
});

/** Zod schema for updating an existing swap row. */
export const swapUpdateSchema = createUpdateSchema(swaps, {
  status: SWAP_STATUS,
  direction: SWAP_DIRECTION,
});

/** A fully-materialized swap lifecycle row as read back from the database. */
export type SwapRow = typeof swaps.$inferSelect;

/** Model-derived shape for inserting a new swap row (all columns, before caller-facing narrowing). */
export type NewSwapRow = typeof swaps.$inferInsert;
