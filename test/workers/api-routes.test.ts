import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";

import type { AuthProps } from "../../src/auth/guards";
import { AppError, CURATED_MESSAGE } from "../../src/errors";
import type { QuoteResult, SwapResult } from "../../src/services/swapService";
import type { ExecuteSwapInput } from "../../src/services/rails";
import type {
  SwapRow,
  TransactionsRepository,
} from "../../src/repository/transactions";

import { createApiApp, type ApiDeps } from "../../src/api/apiApp";

const CANONICAL = "https://swap.example/mcp";

/** A fixed quote fixture; `quotedAmountOut` is reusable as the expected floor. */
const expectedAmountOut = "999000000";
function fakeQuote(): QuoteResult {
  return {
    direction: "ETH_TO_USDC",
    amountIn: "1000000000000000000",
    quotedAmountOut: expectedAmountOut,
    price: "999",
    slippageTolerancePct: 0.5,
    createdAt: 1_700_000_000_000,
    freshUntil: 1_700_000_030_000,
  };
}

/** A concrete confirmed SwapRow the fake repo can hand back. */
function fakeRow(overrides: Partial<SwapRow> = {}): SwapRow {
  return {
    id: "row-1",
    userId: "single-user",
    direction: "ETH_TO_USDC",
    amountIn: "1000000000000000000",
    expectedAmountOut: null,
    quotedAmountOut: expectedAmountOut,
    actualAmountOut: expectedAmountOut,
    slippageTolerancePct: "0.5",
    deadlineSeconds: 1200,
    txHash: "0xabc",
    status: "confirmed",
    errorCode: null,
    gasUsed: "21000",
    createdAt: 1_700_000_000_000,
    submittedAt: 1_700_000_001_000,
    settledAt: 1_700_000_002_000,
    ...overrides,
  };
}

function fakeRepo(
  over: Partial<TransactionsRepository> = {},
): TransactionsRepository {
  return {
    insertPending: async () => "row-1",
    markSubmitted: async () => {},
    markConfirmed: async () => {},
    markFailed: async () => {},
    findById: async () => fakeRow(),
    list: async () => ({ rows: [], nextCursor: null }),
    ...over,
  };
}

function readProps(): AuthProps {
  return {
    userId: "single-user",
    scopes: ["swap:read"],
    resource: CANONICAL,
  };
}

function readWriteProps(): AuthProps {
  return {
    userId: "single-user",
    scopes: ["swap:read", "swap:write"],
    resource: CANONICAL,
  };
}

function fakeSwapResult(overrides: Partial<SwapResult> = {}): SwapResult {
  return {
    transactionId: "row-1",
    status: "confirmed",
    result: "ok",
    txHash: "0xabc",
    quotedAmountOut: expectedAmountOut,
    actualAmountOut: expectedAmountOut,
    gasUsed: "21000",
    ...overrides,
  };
}

type DepsOverrides = {
  service?: ApiDeps["service"];
  coordinator?: ApiDeps["coordinator"];
  repo?: TransactionsRepository;
};

function makeDeps(over: DepsOverrides = {}): ApiDeps {
  return {
    canonicalMcpUri: CANONICAL,
    service: over.service ?? { getQuote: async () => fakeQuote() },
    coordinator: over.coordinator ?? {
      executeSwap: vi.fn(async () => fakeSwapResult()),
    },
    repo: over.repo ?? fakeRepo(),
  };
}

function executionCtxFor(props: AuthProps): ExecutionContext {
  return {
    props,
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

describe("REST API routes", () => {
  test("POST /api/quote mirrors get_quote payload", async () => {
    const app = createApiApp(makeDeps());

    const res = await app.request(
      "/api/quote",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          direction: "ETH_TO_USDC",
          amountIn: "1000000000000000000",
        }),
      },
      {},
      executionCtxFor(readProps()),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ...fakeQuote() });
    // quotedAmountOut is reusable verbatim as execute_swap's expectedAmountOut.
    expect((body as QuoteResult).quotedAmountOut).toBe(expectedAmountOut);
  });

  test("POST /api/swap enforces swap:write and forwards expectedAmountOut", async () => {
    const executeSwap = vi.fn(
      async (_p: ExecuteSwapInput & { userId: string }) => fakeSwapResult(),
    );
    const app = createApiApp(makeDeps({ coordinator: { executeSwap } }));

    const requestBody = {
      direction: "ETH_TO_USDC",
      amountIn: "1000000000000000000",
      expectedAmountOut,
    };

    // Read-only scope must be rejected BEFORE the coordinator is ever called.
    const forbidden = await app.request(
      "/api/swap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      },
      {},
      executionCtxFor(readProps()),
    );
    expect(forbidden.status).toBe(403);
    expect(executeSwap).not.toHaveBeenCalled();

    // Write scope forwards the exact payload plus userId from props (never body).
    const ok = await app.request(
      "/api/swap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...requestBody, userId: "attacker-supplied" }),
      },
      {},
      executionCtxFor(readWriteProps()),
    );

    expect(ok.status).toBe(200);
    expect(executeSwap).toHaveBeenCalledTimes(1);
    const forwarded = executeSwap.mock.calls[0][0];
    expect(forwarded).toEqual({
      direction: "ETH_TO_USDC",
      amountIn: "1000000000000000000",
      expectedAmountOut,
      userId: "single-user",
    });
    // Omitted optional fields are literally absent, not present as undefined.
    expect(
      Object.prototype.hasOwnProperty.call(forwarded, "slippageTolerancePct"),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(forwarded, "deadlineSeconds"),
    ).toBe(false);

    const body = await ok.json();
    expect(body).toEqual(fakeSwapResult());
  });

  test("POST /api/swap surfaces timed_out with row still submitted", async () => {
    const timedOutResult: SwapResult = {
      transactionId: "row-2",
      status: "submitted",
      result: "timed_out",
      txHash: "0xdead",
    };
    const executeSwap = vi.fn(async () => timedOutResult);
    const app = createApiApp(makeDeps({ coordinator: { executeSwap } }));

    const res = await app.request(
      "/api/swap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          direction: "ETH_TO_USDC",
          amountIn: "1000000000000000000",
        }),
      },
      {},
      executionCtxFor(readWriteProps()),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(timedOutResult);
  });

  test("POST /api/swap rejects a token whose resource is not the canonical MCP URI", async () => {
    const executeSwap = vi.fn(
      async (_p: ExecuteSwapInput & { userId: string }) => fakeSwapResult(),
    );
    const app = createApiApp(makeDeps({ coordinator: { executeSwap } }));

    // Valid write scope, but the token's audience (resource) is an attacker's URI.
    const wrongAudienceProps: AuthProps = {
      userId: "single-user",
      scopes: ["swap:read", "swap:write"],
      resource: "https://attacker.example/mcp",
    };

    const res = await app.request(
      "/api/swap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          direction: "ETH_TO_USDC",
          amountIn: "1000000000000000000",
        }),
      },
      {},
      executionCtxFor(wrongAudienceProps),
    );

    expect(res.status).toBe(403);
    expect(executeSwap).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      error: { code: "forbidden", message: CURATED_MESSAGE.forbidden },
    });
  });

  test("GET /api/transactions rejects a non-numeric limit with 400", async () => {
    const list = vi.fn(async () => ({ rows: [], nextCursor: null }));
    const app = createApiApp(makeDeps({ repo: fakeRepo({ list }) }));

    const res = await app.request(
      "/api/transactions?limit=abc",
      {},
      {},
      executionCtxFor(readProps()),
    );

    expect(res.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      error: { code: "invalid_input", message: CURATED_MESSAGE.invalid_input },
    });
  });

  test("GET /api/transactions paginates with nextCursor", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      fakeRow({ id: `row-${i}` }),
    );
    let forwardedLimit: number | undefined;
    const app = createApiApp(
      makeDeps({
        repo: fakeRepo({
          list: async (q) => {
            forwardedLimit = q.limit;
            return { rows, nextCursor: "next-cursor-token" };
          },
        }),
      }),
    );

    const res = await app.request(
      "/api/transactions",
      {},
      {},
      executionCtxFor(readProps()),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: SwapRow[];
      nextCursor: string | null;
    };
    expect(body.rows.length).toBe(20);
    expect(body.nextCursor).toBe("next-cursor-token");
    // default limit is forwarded unmodified so the repo can apply its own default/cap.
    expect(forwardedLimit).toBeUndefined();

    let capLimit: number | undefined;
    const capApp = createApiApp(
      makeDeps({
        repo: fakeRepo({
          list: async (q) => {
            capLimit = q.limit;
            return { rows: [], nextCursor: null };
          },
        }),
      }),
    );
    await capApp.request(
      "/api/transactions?limit=500",
      {},
      {},
      executionCtxFor(readProps()),
    );
    expect(capLimit).toBe(500);
  });

  test("GET /api/transactions rejects tampered cursor with 400", async () => {
    const app = createApiApp(
      makeDeps({
        repo: fakeRepo({
          list: async () => {
            throw new AppError("invalid_input");
          },
        }),
      }),
    );

    const res = await app.request(
      "/api/transactions?cursor=tampered",
      {},
      {},
      executionCtxFor(readProps()),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: "invalid_input", message: CURATED_MESSAGE.invalid_input },
    });
  });

  test("GET /api/transactions/:id returns the live row and 404 on unknown", async () => {
    const app = createApiApp(
      makeDeps({
        repo: fakeRepo({
          findById: async () => fakeRow({ status: "submitted" }),
        }),
      }),
    );

    const res = await app.request(
      "/api/transactions/row-1",
      {},
      {},
      executionCtxFor(readProps()),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SwapRow;
    expect(body.id).toBe("row-1");
    expect(body.status).toBe("submitted");

    const notFoundApp = createApiApp(
      makeDeps({ repo: fakeRepo({ findById: async () => undefined }) }),
    );
    const missing = await notFoundApp.request(
      "/api/transactions/nope",
      {},
      {},
      executionCtxFor(readProps()),
    );
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();
    expect(missingBody).toEqual({
      error: { code: "not_found", message: CURATED_MESSAGE.not_found },
    });
  });

  test("error codes map to matching HTTP statuses", async () => {
    const rateLimitedApp = createApiApp(
      makeDeps({
        service: {
          getQuote: async () => {
            throw new AppError("rate_limited");
          },
        },
      }),
    );
    const rateLimited = await rateLimitedApp.request(
      "/api/quote",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          direction: "ETH_TO_USDC",
          amountIn: "1000000000000000000",
        }),
      },
      {},
      executionCtxFor(readProps()),
    );
    expect(rateLimited.status).toBe(429);
    expect(await rateLimited.json()).toEqual({
      error: { code: "rate_limited", message: CURATED_MESSAGE.rate_limited },
    });

    const approvalApp = createApiApp(
      makeDeps({
        coordinator: {
          executeSwap: async () => {
            throw new AppError("approval_required");
          },
        },
      }),
    );
    const approval = await approvalApp.request(
      "/api/swap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          direction: "ETH_TO_USDC",
          amountIn: "1000000000000000000",
        }),
      },
      {},
      executionCtxFor(readWriteProps()),
    );
    expect(approval.status).toBe(409);
    expect(await approval.json()).toEqual({
      error: {
        code: "approval_required",
        message: CURATED_MESSAGE.approval_required,
      },
    });
  });
});
