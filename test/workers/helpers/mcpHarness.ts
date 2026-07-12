import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ToolDeps } from "../../../src/mcp/tools/deps";

/**
 * Shared MCP test harness: the `ToolResult` narrowing type plus the `call()`,
 * `errorOf()`, and `connectServer()` helpers that were duplicated verbatim
 * across the MCP tool test files. Kept behavior-identical to the originals so
 * the existing tool tests pass unchanged — this is a pure de-duplication.
 */

/** Shape the SDK returns from callTool, narrowed to what the assertions read. */
export type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Read `structuredContent.error` when the result is an error envelope. */
export function errorOf(r: ToolResult): { code: unknown; message: unknown } {
  const err = r.structuredContent?.error;
  if (err === null || typeof err !== "object") {
    throw new Error("expected an error envelope with structuredContent.error");
  }
  return err as { code: unknown; message: unknown };
}

/** Call a tool and narrow the SDK result to {@link ToolResult}. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const raw = await client.callTool({ name, arguments: args });
  return raw as ToolResult;
}

/**
 * Register tools onto a fresh `McpServer` via `register`, wire an in-memory
 * `Client`↔server pair, and return the connected client. Callers pass a
 * registration callback so each test file registers exactly the tools it
 * exercises with its own {@link ToolDeps}.
 */
export async function connectServer(
  deps: ToolDeps,
  register: (server: McpServer, deps: ToolDeps) => void,
): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  register(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}
