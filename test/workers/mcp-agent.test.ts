/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import type { AuthProps } from "../../src/auth/guards";
import { SINGLE_USER_ID } from "../../src/auth/guards";
import type { SwapMcpAgent } from "../../src/mcp/SwapMcpAgent";
import { call, errorOf } from "./helpers/mcpHarness";

// `env.CANONICAL_MCP_URI` is the same var validateEnv reads, so props that use
// it as `resource` clear the audience gate; anything else is a foreign audience.
const CANONICAL = env.CANONICAL_MCP_URI;

const EXPECTED_TOOLS = [
  "get_quote",
  "execute_swap",
  "list_transactions",
  "get_transaction",
] as const;

/** Props that pass audience + both scope gates. */
function okProps(): AuthProps {
  return {
    userId: SINGLE_USER_ID,
    scopes: ["swap:read", "swap:write"],
    resource: CANONICAL,
  };
}

/**
 * Connect an in-memory MCP Client to the agent's already-initialized `server`,
 * so tests drive real tool calls through the same server the transport uses.
 */
async function connectToAgent(agent: SwapMcpAgent): Promise<Client> {
  const server = await agent.server;
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

describe("SwapMcpAgent", () => {
  test("init registers exactly the four tools", async () => {
    const id = env.SwapMcpAgent.idFromName("tools");
    const stub = env.SwapMcpAgent.get(id);

    const names = await runInDurableObject(
      stub,
      async (agent: SwapMcpAgent) => {
        agent.props = okProps();
        await agent.init();
        const client = await connectToAgent(agent);
        const listed = await client.listTools();
        return listed.tools.map((t) => t.name);
      },
    );

    expect(new Set(names)).toEqual(new Set(EXPECTED_TOOLS));
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
  });

  test("getProps is a live thunk over this.props", async () => {
    const id = env.SwapMcpAgent.idFromName("live-thunk");
    const stub = env.SwapMcpAgent.get(id);

    const outcome = await runInDurableObject(
      stub,
      async (agent: SwapMcpAgent) => {
        agent.props = okProps();
        await agent.init();
        const client = await connectToAgent(agent);

        // First call clears the audience + scope gates. It may still error on
        // the downstream quote (no network in the sandbox), but the code is
        // NEVER `forbidden` — the gate let it through to the work.
        const before = await call(client, "get_quote", {
          direction: "ETH_TO_USDC",
          amountIn: "1000000000000000000",
        });

        // Mutate the SAME live agent's props: strip scopes. A captured-at-init
        // thunk would still see the old (valid) props and again pass the gate;
        // a live `() => this.props` sees the new empty scopes, so this call is
        // rejected AT the gate with `forbidden`. The code flip is the proof.
        agent.props = { ...okProps(), scopes: [] };
        const after = await call(client, "get_quote", {
          direction: "ETH_TO_USDC",
          amountIn: "1000000000000000000",
        });

        return { before, after };
      },
    );

    // Before: gate passed (any failure is downstream, never the gate).
    if (outcome.before.isError) {
      expect(errorOf(outcome.before).code).not.toBe("forbidden");
    }
    // After (props mutated to empty scopes): gate now rejects — live read.
    expect(outcome.after.isError).toBe(true);
    expect(errorOf(outcome.after).code).toBe("forbidden");
  });

  test("a tool call with a foreign props.resource returns forbidden", async () => {
    const id = env.SwapMcpAgent.idFromName("foreign-audience");
    const stub = env.SwapMcpAgent.get(id);

    const result = await runInDurableObject(
      stub,
      async (agent: SwapMcpAgent) => {
        agent.props = {
          userId: SINGLE_USER_ID,
          scopes: ["swap:read", "swap:write"],
          resource: "https://attacker.example/mcp",
        };
        await agent.init();
        const client = await connectToAgent(agent);
        return call(client, "get_quote", {
          direction: "ETH_TO_USDC",
          amountIn: "1000000000000000000",
        });
      },
    );

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("forbidden");
  });

  test("agent boots as a SQLite-backed DO", async () => {
    const id = env.SwapMcpAgent.idFromName("test");
    const stub = env.SwapMcpAgent.get(id);

    // The binding resolves to a namespace and yields a usable stub — proof the
    // SQLite-backed DO is declared and boots.
    expect(id).toBeDefined();
    expect(typeof stub.fetch).toBe("function");

    // Reaching into the instance confirms the DO actually instantiates.
    const alive = await runInDurableObject(
      stub,
      async (agent: SwapMcpAgent) => {
        return typeof agent.init === "function";
      },
    );
    expect(alive).toBe(true);
  });
});
