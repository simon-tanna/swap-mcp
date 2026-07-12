/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, test, vi } from "vitest";

import type { AuthProps } from "../../src/auth/guards";
import { SINGLE_USER_ID } from "../../src/auth/guards";
import { CURATED_MESSAGE } from "../../src/errors";
import type { ExecuteSwapInput } from "../../src/services/rails";
import type { QuoteResult, SwapResult } from "../../src/services/swapService";
import type { TransactionsRepository } from "../../src/repository/transactions";
import type { ToolDeps } from "../../src/mcp/tools/deps";

import { registerExecuteSwap } from "../../src/mcp/tools/executeSwap";
import { registerGetQuote } from "../../src/mcp/tools/getQuote";
import { createApiApp, type ApiDeps } from "../../src/api/apiApp";
import { call, connectServer, errorOf } from "./helpers/mcpHarness";

/**
 * The app-owned scope seam (decision 26): the production consent flow always
 * grants BOTH `["swap:read","swap:write"]`, so no narrower bearer is mintable —
 * a read-only token cannot be forged end-to-end. Write-path rejection is instead
 * proven where the app itself owns the boundary: the real `execute_swap`
 * registrar with `deps.getProps` faked to read-only props, and the real
 * `POST /api/swap` route driven through the `propsAdapter` seam with a read-only
 * `executionCtx.props`. Read paths (`get_quote`, `POST /api/quote`) must still
 * succeed on the same read-only props — the gate is scope-specific, not blanket.
 */

const CANONICAL = "https://swap.example/mcp";

/** Read-only auth props: `swap:read` only, correct audience. */
function readOnlyProps(): AuthProps {
  return {
    userId: SINGLE_USER_ID,
    scopes: ["swap:read"],
    resource: CANONICAL,
  };
}

/** A fixed quote fixture whose `quotedAmountOut` doubles as the reusable floor. */
function fakeQuote(): QuoteResult {
  return {
    direction: "ETH_TO_USDC",
    amountIn: "1000000000000000000",
    quotedAmountOut: "999000000",
    price: "999",
    slippageTolerancePct: 0.5,
    createdAt: 1_700_000_000_000,
    freshUntil: 1_700_000_030_000,
  };
}

/** The coordinator port narrowed to the `executeSwap` method the tool/route calls. */
type ExecuteSwapFn = (
  p: ExecuteSwapInput & { userId: string },
) => Promise<SwapResult>;

/** A never-used repo — the scope gate must reject before any persistence. */
function fakeRepo(): TransactionsRepository {
  return {
    insertPending: async () => "row-1",
    markSubmitted: async () => {},
    markConfirmed: async () => {},
    markFailed: async () => {},
    findById: async () => undefined,
    list: async () => ({ rows: [], nextCursor: null }),
  };
}

/** Build real ToolDeps with a read-only `getProps` and a spying coordinator. */
function toolDeps(executeSwap: ExecuteSwapFn): ToolDeps {
  return {
    getProps: readOnlyProps,
    canonicalMcpUri: CANONICAL,
    service: { getQuote: async () => fakeQuote() },
    coordinator: { executeSwap },
    repo: fakeRepo(),
  };
}

/** Build real ApiDeps with a spying coordinator; identity arrives via executionCtx. */
function apiDeps(executeSwap: ExecuteSwapFn): ApiDeps {
  return {
    canonicalMcpUri: CANONICAL,
    service: { getQuote: async () => fakeQuote() },
    coordinator: { executeSwap },
    repo: fakeRepo(),
  };
}

/** Wrap read-only props as the OAuth-provider-populated `executionCtx.props`. */
function readOnlyCtx(): ExecutionContext {
  return {
    props: readOnlyProps(),
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

const VALID_SWAP_INPUT = {
  direction: "ETH_TO_USDC",
  amountIn: "1000000000000000000",
  expectedAmountOut: "999000000",
} as const;

describe("read-only scope seam", () => {
  test("read-only props are rejected by the real registerExecuteSwap registrar", async () => {
    const coordinatorSpy = vi.fn<ExecuteSwapFn>();
    const client = await connectServer(
      toolDeps(coordinatorSpy),
      registerExecuteSwap,
    );

    const result = await call(client, "execute_swap", { ...VALID_SWAP_INPUT });

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("forbidden");
    expect(errorOf(result).message).toBe(CURATED_MESSAGE.forbidden);
    expect(coordinatorSpy).not.toHaveBeenCalled();
  });

  test("read-only props are rejected by the real POST /api/swap route", async () => {
    const coordinatorSpy = vi.fn<ExecuteSwapFn>();
    const app = createApiApp(apiDeps(coordinatorSpy));

    const res = await app.request(
      "/api/swap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...VALID_SWAP_INPUT }),
      },
      {},
      readOnlyCtx(),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "forbidden", message: CURATED_MESSAGE.forbidden },
    });
    expect(coordinatorSpy).not.toHaveBeenCalled();
  });

  test("read props still succeed on read paths", async () => {
    // `get_quote` registrar accepts the same read-only props.
    const unusedCoordinator = vi.fn<ExecuteSwapFn>();
    const quoteClient = await connectServer(
      toolDeps(unusedCoordinator),
      registerGetQuote,
    );
    const quoteResult = await call(quoteClient, "get_quote", {
      direction: "ETH_TO_USDC",
      amountIn: "1000000000000000000",
    });
    expect(quoteResult.isError).toBeFalsy();
    expect(quoteResult.structuredContent).toEqual({ ...fakeQuote() });

    // `POST /api/quote` accepts the same read-only props.
    const app = createApiApp(apiDeps(unusedCoordinator));
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
      readOnlyCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...fakeQuote() });

    expect(unusedCoordinator).not.toHaveBeenCalled();
  });
});
