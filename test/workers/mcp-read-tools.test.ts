import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { AuthProps } from "../../src/auth/guards";
import type { QuoteResult } from "../../src/services/swapService";
import type {
  SwapRow,
  TransactionsRepository,
} from "../../src/repository/transactions";

import {
  registerGetQuote,
  getQuoteInputShape,
} from "../../src/mcp/tools/getQuote";
import {
  registerGetTransaction,
  getTransactionInputShape,
} from "../../src/mcp/tools/getTransaction";
import {
  registerListTransactions,
  listTransactionsInputShape,
} from "../../src/mcp/tools/listTransactions";
import type { ToolDeps } from "../../src/mcp/tools/deps";

const CANONICAL = "https://swap.example/mcp";

/** Shape the SDK returns from callTool, narrowed to what these assertions read. */
type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Read `structuredContent.error` when the result is an error envelope. */
function errorOf(r: ToolResult): { code: unknown; message: unknown } {
  const err = r.structuredContent?.error;
  if (err === null || typeof err !== "object") {
    throw new Error("expected an error envelope with structuredContent.error");
  }
  return err as { code: unknown; message: unknown };
}

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

/** Build a fake repo; each method defaults to a benign value but can be overridden. */
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

/** Valid props for the happy path. */
function okProps(): AuthProps {
  return {
    userId: "single-user",
    scopes: ["swap:read", "swap:write"],
    resource: CANONICAL,
  };
}

type DepsOverrides = {
  getProps?: () => AuthProps;
  service?: ToolDeps["service"];
  repo?: TransactionsRepository;
};

function makeDeps(over: DepsOverrides = {}): ToolDeps {
  return {
    getProps: over.getProps ?? okProps,
    canonicalMcpUri: CANONICAL,
    service: over.service ?? { getQuote: async () => fakeQuote() },
    coordinator: {
      executeSwap: async () => {
        throw new Error("not used by read tools");
      },
    },
    repo: over.repo ?? fakeRepo(),
  };
}

/** Stand up a real McpServer with all three read tools, wire an in-memory Client, return the client. */
async function connect(deps: ToolDeps): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerGetQuote(server, deps);
  registerGetTransaction(server, deps);
  registerListTransactions(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

/** Call a tool and narrow the SDK result to {@link ToolResult}. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const raw = await client.callTool({ name, arguments: args });
  return raw as ToolResult;
}

describe("MCP read tools", () => {
  test("get_quote returns quoted output and freshness in text + structuredContent", async () => {
    const client = await connect(makeDeps());
    const result = await call(client, "get_quote", {
      direction: "ETH_TO_USDC",
      amountIn: "1000000000000000000",
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.quotedAmountOut).toBe(expectedAmountOut);
    expect(result.structuredContent?.freshUntil).toBe(1_700_000_030_000);
    expect(result.content[0].type).toBe("text");
  });

  describe("get_quote requires swap:read", () => {
    test("missing scope yields a forbidden envelope", async () => {
      const client = await connect(
        makeDeps({
          getProps: () => ({
            userId: "single-user",
            scopes: [],
            resource: CANONICAL,
          }),
        }),
      );
      const result = await call(client, "get_quote", {
        direction: "ETH_TO_USDC",
        amountIn: "1000000000000000000",
      });

      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe("forbidden");
    });

    test("wrong audience yields a forbidden envelope (per-tool assertAudience)", async () => {
      const client = await connect(
        makeDeps({
          getProps: () => ({
            userId: "single-user",
            scopes: ["swap:read"],
            resource: "https://attacker.example/mcp",
          }),
        }),
      );
      const result = await call(client, "get_quote", {
        direction: "ETH_TO_USDC",
        amountIn: "1000000000000000000",
      });

      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe("forbidden");
    });
  });

  test("get_transaction returns the live row", async () => {
    const client = await connect(
      makeDeps({
        repo: fakeRepo({
          findById: async () => fakeRow({ status: "submitted" }),
        }),
      }),
    );
    const result = await call(client, "get_transaction", { id: "row-1" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.id).toBe("row-1");
    expect(result.structuredContent?.status).toBe("submitted");
  });

  test("get_transaction returns not_found envelope for unknown id", async () => {
    const client = await connect(
      makeDeps({ repo: fakeRepo({ findById: async () => undefined }) }),
    );
    const result = await call(client, "get_transaction", { id: "nope" });

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("not_found");
  });

  test("list_transactions paginates with nextCursor and rejects tampered cursors", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      fakeRow({ id: `row-${i}` }),
    );
    const client = await connect(
      makeDeps({
        repo: fakeRepo({
          list: async () => ({ rows, nextCursor: "next-cursor-token" }),
        }),
      }),
    );
    const page = await call(client, "list_transactions", {});
    expect(page.isError).toBeFalsy();
    const pageRows = page.structuredContent?.rows;
    expect(Array.isArray(pageRows) ? pageRows.length : -1).toBe(20);
    expect(page.structuredContent?.nextCursor).toBe("next-cursor-token");

    // Tampered cursor: repo throws AppError("invalid_input").
    const { AppError } = await import("../../src/errors");
    const badClient = await connect(
      makeDeps({
        repo: fakeRepo({
          list: async () => {
            throw new AppError("invalid_input");
          },
        }),
      }),
    );
    const bad = await call(badClient, "list_transactions", {
      cursor: "tampered",
    });
    expect(bad.isError).toBe(true);
    expect(errorOf(bad).code).toBe("invalid_input");

    // limit is forwarded UNMODIFIED so the repo can cap it (repo's job).
    let forwardedLimit: number | undefined;
    const capClient = await connect(
      makeDeps({
        repo: fakeRepo({
          list: async (q) => {
            forwardedLimit = q.limit;
            return { rows: [], nextCursor: null };
          },
        }),
      }),
    );
    await call(capClient, "list_transactions", { limit: 500 });
    expect(forwardedLimit).toBe(500);
  });

  test("all failures pass through toErrorEnvelope", async () => {
    const secret = "raw-internal-detail-should-not-leak";
    const client = await connect(
      makeDeps({
        repo: fakeRepo({
          findById: async () => {
            throw new Error(secret);
          },
        }),
      }),
    );
    const result = await call(client, "get_transaction", { id: "row-1" });

    expect(result.isError).toBe(true);
    const err = errorOf(result);
    expect(err.code).toBe("internal");
    expect(String(err.message)).not.toContain(secret);
    expect(result.content[0].text ?? "").not.toContain(secret);
  });

  test("input schemas are bare Zod v4 raw shapes", () => {
    for (const shape of [
      getQuoteInputShape,
      getTransactionInputShape,
      listTransactionsInputShape,
    ]) {
      // A raw shape is a plain object, NOT a ZodObject.
      expect(typeof shape).toBe("object");
      expect(shape).not.toBeInstanceOf(z.ZodObject);
      expect(shape).not.toHaveProperty("shape");
    }
    // Representative fields are Zod schema instances (have .parse / ._def).
    expect(typeof getQuoteInputShape.direction.parse).toBe("function");
    expect(getQuoteInputShape.amountIn).toHaveProperty("_def");
    expect(typeof getTransactionInputShape.id.parse).toBe("function");
    expect(listTransactionsInputShape.limit).toHaveProperty("_def");
  });
});
