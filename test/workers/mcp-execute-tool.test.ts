import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, test, vi } from "vitest";

import { AppError } from "../../src/errors";
import { SINGLE_USER_ID, type AuthProps } from "../../src/auth/guards";
import type { ExecuteSwapInput } from "../../src/services/rails";
import type { SwapResult } from "../../src/services/swapService";
import type { ToolDeps } from "../../src/mcp/tools/deps";

import { registerExecuteSwap } from "../../src/mcp/tools/executeSwap";
import { call, connectServer, errorOf } from "./helpers/mcpHarness";

const CANONICAL = "https://swap.example/mcp";

/** The coordinator port narrowed to just the executeSwap method the tool calls. */
type ExecuteSwapFn = (
  p: ExecuteSwapInput & { userId: string },
) => Promise<SwapResult>;

/** Valid props with write scope for the happy path. */
function okProps(): AuthProps {
  return {
    userId: SINGLE_USER_ID,
    scopes: ["swap:read", "swap:write"],
    resource: CANONICAL,
  };
}

/** A confirmed SwapResult fixture. */
function confirmedResult(): SwapResult {
  return {
    transactionId: "tx1",
    status: "confirmed",
    result: "ok",
    txHash: "0xabc",
    quotedAmountOut: "999000000",
    actualAmountOut: "999000000",
    gasUsed: "21000",
  };
}

type DepsOverrides = {
  getProps?: () => AuthProps;
  executeSwap?: ExecuteSwapFn;
};

function makeDeps(over: DepsOverrides = {}): ToolDeps {
  return {
    getProps: over.getProps ?? okProps,
    canonicalMcpUri: CANONICAL,
    service: {
      getQuote: async () => {
        throw new Error("not used by execute tool");
      },
    },
    coordinator: {
      executeSwap:
        over.executeSwap ??
        (async () => {
          throw new Error("not configured");
        }),
    },
    repo: {
      insertPending: async () => "row-1",
      markSubmitted: async () => {},
      markConfirmed: async () => {},
      markFailed: async () => {},
      findById: async () => undefined,
      list: async () => ({ rows: [], nextCursor: null }),
    },
  };
}

/** Stand up a real McpServer with execute_swap, wire an in-memory Client, return the client. */
async function connect(deps: ToolDeps): Promise<Client> {
  return connectServer(deps, registerExecuteSwap);
}

const VALID_INPUT = {
  direction: "ETH_TO_USDC",
  amountIn: "1000000000000000000",
  expectedAmountOut: "999000000",
  slippageTolerancePct: 0.5,
  deadlineSeconds: 1200,
} as const;

describe("MCP execute_swap tool", () => {
  test("execute_swap requires swap:write", async () => {
    // missing write scope (read only) → forbidden, coordinator never touched.
    const readOnlySpy = vi.fn<ExecuteSwapFn>();
    const readOnlyClient = await connect(
      makeDeps({
        getProps: () => ({
          userId: SINGLE_USER_ID,
          scopes: ["swap:read"],
          resource: CANONICAL,
        }),
        executeSwap: readOnlySpy,
      }),
    );
    const readOnlyResult = await call(readOnlyClient, "execute_swap", {
      ...VALID_INPUT,
    });
    expect(readOnlyResult.isError).toBe(true);
    expect(errorOf(readOnlyResult).code).toBe("forbidden");
    expect(readOnlySpy).not.toHaveBeenCalled();

    // wrong audience despite a valid write scope → forbidden, coordinator untouched.
    const audienceSpy = vi.fn<ExecuteSwapFn>();
    const audienceClient = await connect(
      makeDeps({
        getProps: () => ({
          userId: SINGLE_USER_ID,
          scopes: ["swap:write"],
          resource: "https://attacker.example/mcp",
        }),
        executeSwap: audienceSpy,
      }),
    );
    const audienceResult = await call(audienceClient, "execute_swap", {
      ...VALID_INPUT,
    });
    expect(audienceResult.isError).toBe(true);
    expect(errorOf(audienceResult).code).toBe("forbidden");
    expect(audienceSpy).not.toHaveBeenCalled();
  });

  test("execute_swap forwards the full input including optional expectedAmountOut", async () => {
    const spy = vi.fn<ExecuteSwapFn>().mockResolvedValue(confirmedResult());
    const client = await connect(makeDeps({ executeSwap: spy }));

    await call(client, "execute_swap", { ...VALID_INPUT });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({
      direction: "ETH_TO_USDC",
      amountIn: "1000000000000000000",
      expectedAmountOut: "999000000",
      slippageTolerancePct: 0.5,
      deadlineSeconds: 1200,
      userId: SINGLE_USER_ID,
    });

    // When expectedAmountOut is OMITTED, the forwarded object has NO such key.
    const spy2 = vi.fn<ExecuteSwapFn>().mockResolvedValue(confirmedResult());
    const client2 = await connect(makeDeps({ executeSwap: spy2 }));
    await call(client2, "execute_swap", {
      direction: "ETH_TO_USDC",
      amountIn: "1000000000000000000",
    });
    expect(spy2).toHaveBeenCalledTimes(1);
    const forwarded = spy2.mock.calls[0][0];
    expect("expectedAmountOut" in forwarded).toBe(false);
    expect("slippageTolerancePct" in forwarded).toBe(false);
    expect("deadlineSeconds" in forwarded).toBe(false);
    expect(forwarded).toEqual({
      direction: "ETH_TO_USDC",
      amountIn: "1000000000000000000",
      userId: SINGLE_USER_ID,
    });
  });

  test("execute_swap returns terminal payload with result field", async () => {
    const client = await connect(
      makeDeps({ executeSwap: async () => confirmedResult() }),
    );
    const result = await call(client, "execute_swap", { ...VALID_INPUT });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.status).toBe("confirmed");
    expect(result.structuredContent?.result).toBe("ok");
    expect(result.structuredContent?.txHash).toBe("0xabc");
    expect(result.structuredContent?.actualAmountOut).toBe("999000000");
    expect(result.structuredContent?.gasUsed).toBe("21000");
    expect(result.structuredContent?.transactionId).toBe("tx1");

    // timed_out passes through with status "submitted" / result "timed_out".
    const timedOut: SwapResult = {
      transactionId: "tx2",
      status: "submitted",
      result: "timed_out",
      txHash: "0xdef",
    };
    const timedOutClient = await connect(
      makeDeps({ executeSwap: async () => timedOut }),
    );
    const timedOutResult = await call(timedOutClient, "execute_swap", {
      ...VALID_INPUT,
    });
    expect(timedOutResult.isError).toBeFalsy();
    expect(timedOutResult.structuredContent?.status).toBe("submitted");
    expect(timedOutResult.structuredContent?.result).toBe("timed_out");
    expect(timedOutResult.structuredContent?.transactionId).toBe("tx2");
  });

  test("coordinator failures surface as envelopes", async () => {
    // AppError → curated code + curated message (no raw thrown text).
    const client = await connect(
      makeDeps({
        executeSwap: async () => {
          throw new AppError("insufficient_balance");
        },
      }),
    );
    const result = await call(client, "execute_swap", { ...VALID_INPUT });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("insufficient_balance");
    expect(errorOf(result).message).toBe(
      "The wallet balance is insufficient for this swap.",
    );

    // Major-5 leak channel: a non-AppError carrying a fake rpc url + hex key
    // must classify to "internal" and the curated message must replace the raw
    // text — neither the rpc url nor the long hex run may appear in the envelope.
    const rpcUrl = "https://secret-rpc.example.com/v3/deadbeef";
    const hexKey = "0x" + "a".repeat(64);
    const leakClient = await connect(
      makeDeps({
        executeSwap: async () => {
          throw new Error(`boom rpc=${rpcUrl} key=${hexKey}`);
        },
      }),
    );
    const leaked = await call(leakClient, "execute_swap", { ...VALID_INPUT });
    expect(leaked.isError).toBe(true);
    expect(errorOf(leaked).code).toBe("internal");
    const serialized = JSON.stringify(leaked);
    expect(serialized).not.toContain(rpcUrl);
    expect(serialized).not.toContain("a".repeat(64));
  });
});
