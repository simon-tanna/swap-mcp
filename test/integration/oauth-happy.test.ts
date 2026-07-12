import { SELF, env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import workerDefault from "../../src/index";
import { firstAllowedOrigin, mintToken } from "../helpers/mintToken";

/**
 * End-to-end integration coverage for the wired worker (`src/index.ts` default
 * export). Every request goes through `SELF`, which routes to the real `main`
 * binding — the OAuthProvider guarding both the MCP and REST surfaces and
 * delegating the public consent flow to `publicApp`. No handlers are faked.
 */

const EXPECTED_TOOLS = [
  "get_quote",
  "get_transaction",
  "list_transactions",
  "execute_swap",
];

/** A supported MCP protocol version the streamable-HTTP transport accepts. */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Base URL for worker requests. The OAuthProvider validates a bearer token's
 * audience against `${protocol}//${host}${pathname}` of the request, so requests
 * must share the origin the token was minted for (the canonical MCP URI's host).
 */
function workerBase(): string {
  return new URL(env.CANONICAL_MCP_URI).origin;
}

describe("OAuthProvider integration happy path", () => {
  test("well-knowns and register resolve publicly", async () => {
    const asMeta = await SELF.fetch(
      "https://worker/.well-known/oauth-authorization-server",
    );
    expect(asMeta.status).toBe(200);
    expect(asMeta.headers.get("content-type")).toContain("application/json");
    const asBody = (await asMeta.json()) as Record<string, unknown>;
    expect(typeof asBody.authorization_endpoint).toBe("string");
    expect(typeof asBody.token_endpoint).toBe("string");

    const prMeta = await SELF.fetch(
      "https://worker/.well-known/oauth-protected-resource",
    );
    expect(prMeta.status).toBe(200);
    expect(prMeta.headers.get("content-type")).toContain("application/json");
    const prBody = (await prMeta.json()) as Record<string, unknown>;
    expect(prBody).toBeTypeOf("object");

    // Open dynamic client registration accepts a client.
    const reg = await SELF.fetch("https://worker/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
        client_name: "wellknown-test-client",
      }),
    });
    expect([200, 201]).toContain(reg.status);
    const regBody = (await reg.json()) as { client_id?: string };
    expect(typeof regBody.client_id).toBe("string");
  });

  test("unauthenticated /mcp and /api are rejected", async () => {
    const apiRes = await SELF.fetch("https://worker/api/transactions");
    expect(apiRes.status).toBe(401);

    const mcpRes = await SELF.fetch("https://worker/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        Origin: firstAllowedOrigin(),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "int-test", version: "0.0.0" },
        },
      }),
    });
    expect(mcpRes.status).toBe(401);
  });

  test("healthz is public and constant", async () => {
    const res = await SELF.fetch("https://worker/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ status: "ok" });
  });

  test("the full consent dance mints a token accepted by both surfaces", async () => {
    const { accessToken } = await mintToken();
    const origin = firstAllowedOrigin();

    // (a) Authorize POST /mcp: initialize then tools/list, listing four tools.
    const initResult = await mcpCall(accessToken, origin, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "int-test", version: "0.0.0" },
      },
    });
    expect(initResult.response.status).toBe(200);

    const listResult = await mcpCall(
      accessToken,
      origin,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      initResult.sessionId,
    );
    expect(listResult.response.status).toBe(200);
    const tools = (
      listResult.body?.result as { tools?: Array<{ name: string }> } | undefined
    )?.tools;
    expect(tools).toBeDefined();
    const names = (tools ?? []).map((t) => t.name);
    expect(new Set(names)).toEqual(new Set(EXPECTED_TOOLS));

    // (b) Authorize GET /api/transactions.
    const apiRes = await SELF.fetch(`${workerBase()}/api/transactions`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(apiRes.status).toBe(200);
    const apiBody = (await apiRes.json()) as {
      rows: unknown[];
      nextCursor: string | null;
    };
    expect(Array.isArray(apiBody.rows)).toBe(true);
  });

  test("default export is an OAuthProvider instance", () => {
    // Shape assertion: the OAuthProvider exposes a fetch handler and the
    // purgeExpiredData helper unique to the provider class.
    expect(typeof workerDefault.fetch).toBe("function");
    expect(
      typeof (workerDefault as { purgeExpiredData?: unknown }).purgeExpiredData,
    ).toBe("function");
    expect(workerDefault.constructor?.name).toBe("OAuthProvider");
  });
});

/**
 * Perform one authenticated MCP JSON-RPC call over the streamable-HTTP
 * transport and parse the response, whether it comes back as JSON or SSE. When
 * the server assigns a session id on `initialize`, capture it so `tools/list`
 * can reuse the same session.
 */
async function mcpCall(
  accessToken: string,
  origin: string,
  payload: Record<string, unknown>,
  sessionId?: string,
): Promise<{
  response: Response;
  body: { result?: unknown; error?: unknown } | undefined;
  sessionId: string | undefined;
}> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    Origin: origin,
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const response = await SELF.fetch(`${workerBase()}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const returnedSession =
    response.headers.get("Mcp-Session-Id") ?? sessionId ?? undefined;

  const body = await parseRpcBody(response);
  return { response, body, sessionId: returnedSession };
}

/** Parse a JSON-RPC response body from either a JSON or an SSE-framed response. */
async function parseRpcBody(
  response: Response,
): Promise<{ result?: unknown; error?: unknown } | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  if (contentType.includes("text/event-stream")) {
    // Concatenate every `data:` line, then parse the last JSON payload — the
    // final SSE event carries the JSON-RPC response for the request id.
    const dataChunks: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataChunks.push(line.slice("data:".length).trim());
      }
    }
    for (let i = dataChunks.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(dataChunks[i]);
      } catch {
        // keep walking back to the last well-formed JSON data frame
      }
    }
    return undefined;
  }
  return JSON.parse(text);
}
