/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import * as schema from "../../src/db/schema";

describe("swaps schema migrations", () => {
  test("migrations create the swaps table with all lifecycle columns", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(swaps)").all<{
      name: string;
    }>();
    const columns = results.map((r) => r.name);

    expect(columns).toEqual([
      "id",
      "userId",
      "direction",
      "amountIn",
      "expectedAmountOut",
      "quotedAmountOut",
      "actualAmountOut",
      "slippageTolerancePct",
      "deadlineSeconds",
      "txHash",
      "status",
      "errorCode",
      "gasUsed",
      "createdAt",
      "submittedAt",
      "settledAt",
    ]);
  });

  test("a full row inserts and reads back via drizzle", async () => {
    const db = drizzle(env.DB, { schema });

    const row = {
      id: "11111111-1111-1111-1111-111111111111",
      userId: "user-1",
      direction: "ETH_TO_USDC" as const,
      amountIn: "1000000000000000000",
      expectedAmountOut: null,
      quotedAmountOut: "2500000000",
      actualAmountOut: null,
      slippageTolerancePct: "0.5",
      deadlineSeconds: 1800,
      txHash: null,
      status: "pending" as const,
      errorCode: null,
      gasUsed: null,
      createdAt: 1_700_000_000_000,
      submittedAt: null,
      settledAt: null,
    };

    await db.insert(schema.swaps).values(row);

    const [readBack] = await db
      .select()
      .from(schema.swaps)
      .where(eq(schema.swaps.id, row.id));

    expect(readBack).toEqual(row);
  });

  test("status column admits exactly the four lifecycle values", async () => {
    const db = drizzle(env.DB, { schema });

    await expect(
      db.insert(schema.swaps).values({
        id: "22222222-2222-2222-2222-222222222222",
        userId: "user-1",
        direction: "ETH_TO_USDC",
        amountIn: "1",
        quotedAmountOut: "1",
        slippageTolerancePct: "0.5",
        deadlineSeconds: 60,
        status: "timed_out" as unknown as "pending",
        createdAt: 1,
      }),
    ).rejects.toThrow();
  });
});
