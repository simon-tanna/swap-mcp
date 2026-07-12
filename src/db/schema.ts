import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
