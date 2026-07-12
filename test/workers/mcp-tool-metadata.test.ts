import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, test } from "vitest";

import type { AuthProps } from "../../src/auth/guards";
import type { QuoteResult } from "../../src/services/swapService";
import type {
  SwapRow,
  TransactionsRepository,
} from "../../src/repository/transactions";

import { registerGetQuote } from "../../src/mcp/tools/getQuote";
import { registerExecuteSwap } from "../../src/mcp/tools/executeSwap";
import { registerGetTransaction } from "../../src/mcp/tools/getTransaction";
import { registerListTransactions } from "../../src/mcp/tools/listTransactions";
import type { ToolDeps } from "../../src/mcp/tools/deps";
import { connectServer } from "./helpers/mcpHarness";

const CANONICAL = "https://swap.example/mcp";

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

function fakeRow(overrides: Partial<SwapRow> = {}): SwapRow {
  return {
    id: "row-1",
    userId: "single-user",
    direction: "ETH_TO_USDC",
    amountIn: "1000000000000000000",
    expectedAmountOut: null,
    quotedAmountOut: "999000000",
    actualAmountOut: "999000000",
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

function okProps(): AuthProps {
  return {
    userId: "single-user",
    scopes: ["swap:read", "swap:write"],
    resource: CANONICAL,
  };
}

function makeDeps(over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    getProps: okProps,
    canonicalMcpUri: CANONICAL,
    service: { getQuote: async () => fakeQuote() },
    coordinator: {
      executeSwap: async () => {
        throw new Error("not used for metadata");
      },
    },
    repo: fakeRepo(),
    ...over,
  };
}

/** Stand up all four tools and return the connected client. */
async function connectAll(deps: ToolDeps): Promise<Client> {
  return connectServer(deps, (server, d) => {
    registerGetQuote(server, d);
    registerExecuteSwap(server, d);
    registerGetTransaction(server, d);
    registerListTransactions(server, d);
  });
}

type ListedTool = {
  name: string;
  description?: string;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
  outputSchema?: unknown;
};

/** Call a tool through the SDK client, returning the narrowed result. */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }> {
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
}

async function toolsByName(client: Client): Promise<Map<string, ListedTool>> {
  const listed = await client.listTools();
  return new Map((listed.tools as ListedTool[]).map((t) => [t.name, t]));
}

describe("MCP tool metadata", () => {
  test("every tool carries a title and read/write annotations", async () => {
    const tools = await toolsByName(await connectAll(makeDeps()));

    // The three read tools are read-only and non-destructive.
    for (const name of ["get_quote", "get_transaction", "list_transactions"]) {
      const t = tools.get(name);
      expect(t, `${name} should be registered`).toBeDefined();
      expect(t?.annotations?.title, `${name} title`).toBeTruthy();
      expect(t?.annotations?.readOnlyHint, `${name} readOnlyHint`).toBe(true);
      expect(t?.annotations?.destructiveHint, `${name} destructiveHint`).toBe(
        false,
      );
    }

    // The write/money tool is destructive and NOT read-only.
    const exec = tools.get("execute_swap");
    expect(exec?.annotations?.title).toBeTruthy();
    expect(exec?.annotations?.readOnlyHint).toBe(false);
    expect(exec?.annotations?.destructiveHint).toBe(true);
  });

  test("get_quote declares an outputSchema and a successful call validates against it", async () => {
    const client = await connectAll(makeDeps());

    // The tool advertises a typed output contract clients can validate against.
    const tools = await toolsByName(client);
    expect(tools.get("get_quote")?.outputSchema).toBeDefined();

    // A real success must pass the SDK's output validation (no isError), and the
    // structuredContent carries the quote fields.
    const result = await callTool(client, "get_quote", {
      direction: "ETH_TO_USDC",
      amountIn: "1000000000000000000",
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.quotedAmountOut).toBe("999000000");
    expect(result.structuredContent?.freshUntil).toBe(1_700_000_030_000);
  });

  test("execute_swap declares an outputSchema and both confirmed and timed_out results validate", async () => {
    // A confirmed swap: status "confirmed" / result "ok", all optional fields present.
    const confirmed = await connectAll(
      makeDeps({
        coordinator: {
          executeSwap: async () => ({
            transactionId: "tx1",
            status: "confirmed",
            result: "ok",
            txHash: "0xabc",
            quotedAmountOut: "999000000",
            actualAmountOut: "999000000",
            gasUsed: "21000",
          }),
        },
      }),
    );
    expect(
      (await toolsByName(confirmed)).get("execute_swap")?.outputSchema,
    ).toBeDefined();
    const okResult = await callTool(confirmed, "execute_swap", {
      direction: "ETH_TO_USDC",
      amountIn: "1000000000000000000",
    });
    expect(okResult.isError).toBeFalsy();
    expect(okResult.structuredContent?.result).toBe("ok");

    // A timed-out swap: status "submitted" / result "timed_out", optionals omitted
    // (the SwapResult-derived shape must mark them .optional()).
    const timedOut = await connectAll(
      makeDeps({
        coordinator: {
          executeSwap: async () => ({
            transactionId: "tx2",
            status: "submitted",
            result: "timed_out",
            txHash: "0xdef",
          }),
        },
      }),
    );
    const timedResult = await callTool(timedOut, "execute_swap", {
      direction: "ETH_TO_USDC",
      amountIn: "1000000000000000000",
    });
    expect(timedResult.isError).toBeFalsy();
    expect(timedResult.structuredContent?.result).toBe("timed_out");
  });

  test("get_transaction declares an outputSchema and an all-null pending row validates", async () => {
    // A pending row: every nullable column is explicit null (not omitted). This
    // is the case the drizzle-zod `.nullable()` (not `.optional()`) shape must accept.
    const pendingRow = fakeRow({
      status: "pending",
      expectedAmountOut: null,
      actualAmountOut: null,
      txHash: null,
      errorCode: null,
      gasUsed: null,
      submittedAt: null,
      settledAt: null,
    });
    const client = await connectAll(
      makeDeps({ repo: fakeRepo({ findById: async () => pendingRow }) }),
    );

    expect(
      (await toolsByName(client)).get("get_transaction")?.outputSchema,
    ).toBeDefined();
    const result = await callTool(client, "get_transaction", { id: "row-1" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.status).toBe("pending");
    expect(result.structuredContent?.txHash).toBeNull();
  });

  test("list_transactions declares an outputSchema and a non-empty page of full rows validates", async () => {
    const rows = [fakeRow({ id: "row-1" }), fakeRow({ id: "row-2" })];
    const client = await connectAll(
      makeDeps({
        repo: fakeRepo({
          list: async () => ({ rows, nextCursor: "cursor-2" }),
        }),
      }),
    );

    expect(
      (await toolsByName(client)).get("list_transactions")?.outputSchema,
    ).toBeDefined();
    const result = await callTool(client, "list_transactions", {});
    expect(result.isError).toBeFalsy();
    const pageRows = result.structuredContent?.rows;
    expect(Array.isArray(pageRows) ? pageRows.length : -1).toBe(2);
    expect(result.structuredContent?.nextCursor).toBe("cursor-2");
  });

  test("every tool has a substantive description; execute_swap states its real contract", async () => {
    const tools = await toolsByName(await connectAll(makeDeps()));

    for (const name of [
      "get_quote",
      "execute_swap",
      "get_transaction",
      "list_transactions",
    ]) {
      const desc = tools.get(name)?.description ?? "";
      expect(desc.length, `${name} description length`).toBeGreaterThan(30);
    }

    // execute_swap: internal scope noise removed; the real, caller-relevant
    // facts (on-chain broadcast + base units) are stated instead.
    const exec = tools.get("execute_swap")?.description ?? "";
    expect(exec).not.toContain("swap:write");
    expect(exec.toLowerCase()).toContain("on-chain");
    expect(exec.toLowerCase()).toContain("base units");
  });

  test("get_quote rejects a non-integer amountIn at the input schema", async () => {
    const client = await connectAll(makeDeps());
    // "1.5" is a decimal, not base units — the tightened `^\d+$` regex must
    // reject it before the tool body (and the service) is ever reached.
    const result = await callTool(client, "get_quote", {
      direction: "ETH_TO_USDC",
      amountIn: "1.5",
    });
    expect(result.isError).toBe(true);
  });
});
