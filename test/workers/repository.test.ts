/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import * as schema from "../../src/db/schema";
import { swaps } from "../../src/db/schema";
import { AppError } from "../../src/errors";
import {
  createTransactionsRepository,
  type NewSwapInput,
} from "../../src/repository/transactions";

const db = drizzle(env.DB, { schema });
const repo = createTransactionsRepository(db);

function newInput(overrides: Partial<NewSwapInput> = {}): NewSwapInput {
  return {
    userId: "user-1",
    direction: "ETH_TO_USDC",
    amountIn: "1000000000000000000",
    quotedAmountOut: "2500000000",
    slippageTolerancePct: "0.5",
    deadlineSeconds: 1800,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.delete(swaps);
});

describe("transactions repository", () => {
  test("insertPending creates a pending row", async () => {
    const id = await repo.insertPending(newInput());

    const row = await db.query.swaps.findFirst({ where: eq(swaps.id, id) });
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending");
    expect(row!.createdAt).toBeGreaterThan(0);
    expect(row!.txHash).toBeNull();
  });

  test("markSubmitted / markConfirmed / markFailed transition the row", async () => {
    const submittedId = await repo.insertPending(newInput());
    await repo.markSubmitted(submittedId, "0xabc");
    let row = await db.query.swaps.findFirst({
      where: eq(swaps.id, submittedId),
    });
    expect(row!.status).toBe("submitted");
    expect(row!.txHash).toBe("0xabc");
    expect(row!.submittedAt).toBeGreaterThan(0);

    const confirmedId = await repo.insertPending(newInput());
    await repo.markSubmitted(confirmedId, "0xdef");
    await repo.markConfirmed(confirmedId, {
      actualAmountOut: "2490000000",
      gasUsed: "21000",
    });
    row = await db.query.swaps.findFirst({ where: eq(swaps.id, confirmedId) });
    expect(row!.status).toBe("confirmed");
    expect(row!.actualAmountOut).toBe("2490000000");
    expect(row!.gasUsed).toBe("21000");
    expect(row!.settledAt).toBeGreaterThan(0);

    const failedId = await repo.insertPending(newInput());
    await repo.markSubmitted(failedId, "0x123");
    await repo.markFailed(failedId, "swap_failed", { txHash: "0x123" });
    row = await db.query.swaps.findFirst({ where: eq(swaps.id, failedId) });
    expect(row!.status).toBe("failed");
    expect(row!.txHash).toBe("0x123");
  });

  test("markFailed records errorCode without txHash for pre-submit aborts", async () => {
    const id = await repo.insertPending(newInput());
    await repo.markFailed(id, "slippage_exceeded");

    const row = await db.query.swaps.findFirst({ where: eq(swaps.id, id) });
    expect(row!.status).toBe("failed");
    expect(row!.errorCode).toBe("slippage_exceeded");
    expect(row!.txHash).toBeNull();
  });

  test("markFailed without opts preserves a previously recorded txHash (post-submit failure)", async () => {
    const id = await repo.insertPending(newInput());
    await repo.markSubmitted(id, "0xhash...");
    await repo.markFailed(id, "swap_failed");

    const row = await db.query.swaps.findFirst({ where: eq(swaps.id, id) });
    expect(row!.status).toBe("failed");
    expect(row!.errorCode).toBe("swap_failed");
    expect(row!.txHash).toBe("0xhash...");
  });

  test("findById returns the live row", async () => {
    const id = await repo.insertPending(newInput());

    const row = await repo.findById(id);
    expect(row).toBeDefined();
    expect(row!.id).toBe(id);

    const missing = await repo.findById("00000000-0000-0000-0000-000000000000");
    expect(missing).toBeUndefined();
  });

  test("list paginates by (createdAt, id) with default 20 and cap 100", async () => {
    for (let i = 0; i < 25; i++) {
      const id = await repo.insertPending(newInput());
      // Space createdAt apart deterministically for unambiguous ordering.
      await db
        .update(swaps)
        .set({ createdAt: 1_700_000_000_000 + i })
        .where(eq(swaps.id, id));
    }

    const page1 = await repo.list({});
    expect(page1.rows).toHaveLength(20);
    expect(page1.nextCursor).not.toBeNull();

    // Ordered by (createdAt, id) DESC.
    for (let i = 1; i < page1.rows.length; i++) {
      const prev = page1.rows[i - 1];
      const curr = page1.rows[i];
      const ordered =
        prev.createdAt > curr.createdAt ||
        (prev.createdAt === curr.createdAt && prev.id > curr.id);
      expect(ordered).toBe(true);
    }

    const page2 = await repo.list({ cursor: page1.nextCursor! });
    expect(page2.rows).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();

    // The two pages don't overlap.
    const ids1 = new Set(page1.rows.map((r) => r.id));
    for (const r of page2.rows) {
      expect(ids1.has(r.id)).toBe(false);
    }

    const capped = await repo.list({ limit: 500 });
    expect(capped.rows.length).toBeLessThanOrEqual(100);
  });

  test("list rejects a tampered cursor", async () => {
    await expect(repo.list({ cursor: "not-a-valid-cursor" })).rejects.toThrow(
      AppError,
    );
    await expect(
      repo.list({ cursor: "not-a-valid-cursor" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("list filters by status", async () => {
    const failedId = await repo.insertPending(newInput());
    await repo.markFailed(failedId, "swap_failed");
    await repo.insertPending(newInput());
    await repo.insertPending(newInput());

    const result = await repo.list({ status: "failed" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows.every((r) => r.status === "failed")).toBe(true);
    expect(result.rows[0].id).toBe(failedId);
  });
});
