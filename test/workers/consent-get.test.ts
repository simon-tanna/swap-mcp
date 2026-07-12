import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import {
  issueCsrfToken,
  verifyAndConsumeCsrfToken,
  type AuthRequestLike,
} from "../../src/oauth/csrf";
import { publicApp } from "../../src/oauth/publicApp";

const CANONICAL = "https://swap-mcp.example.workers.dev/mcp";
const REDIRECT_URI = "https://client.example/callback";
const CLIENT_NAME = "Example <Trading> Client";

/** A parsed AuthRequest fixture the fake `parseAuthRequest` returns. */
function fakeAuthRequest(
  overrides: Partial<AuthRequestLike> = {},
): AuthRequestLike {
  return {
    clientId: "client-123",
    redirectUri: REDIRECT_URI,
    scope: ["swap"],
    state: "opaque-state",
    resource: CANONICAL,
    ...overrides,
  };
}

/** A fake OAUTH_PROVIDER binding exposing only the two helpers the GET uses. */
function fakeProvider(opts: {
  authRequest: AuthRequestLike;
  redirectUris?: string[];
}) {
  return {
    async parseAuthRequest() {
      return opts.authRequest;
    },
    async lookupClient(clientId: string) {
      return {
        clientId,
        redirectUris: opts.redirectUris ?? [REDIRECT_URI],
        clientName: CLIENT_NAME,
      };
    },
  };
}

/** Build the env object passed as Hono's third `request` argument. */
function testEnv(provider: unknown) {
  return {
    OAUTH_KV: env.OAUTH_KV,
    CANONICAL_MCP_URI: CANONICAL,
    OAUTH_PROVIDER: provider,
  };
}

describe("CSRF codec", () => {
  test("csrf token is single-use and bound to the AuthRequest", async () => {
    const authRequestA = fakeAuthRequest();
    const authRequestB = fakeAuthRequest({ redirectUri: "https://other/cb" });

    const token = await issueCsrfToken(env.OAUTH_KV, authRequestA);

    // A token issued for A must not verify against a different request B.
    expect(
      await verifyAndConsumeCsrfToken(env.OAUTH_KV, token, authRequestB),
    ).toBe(false);

    // But the mismatch attempt must not consume the token bound to A: reissue
    // to keep this assertion independent — a fresh token verifies once for A...
    const tokenA = await issueCsrfToken(env.OAUTH_KV, authRequestA);
    expect(
      await verifyAndConsumeCsrfToken(env.OAUTH_KV, tokenA, authRequestA),
    ).toBe(true);

    // ...and fails on replay (delete-on-read, single-use).
    expect(
      await verifyAndConsumeCsrfToken(env.OAUTH_KV, tokenA, authRequestA),
    ).toBe(false);
  });
});

describe("publicApp GET /authorize", () => {
  test("GET /authorize renders client name and exact redirect_uri with a hidden csrf field", async () => {
    const provider = fakeProvider({ authRequest: fakeAuthRequest() });
    const res = await publicApp.request("/authorize", {}, testEnv(provider));

    expect(res.status).toBe(200);
    const html = await res.text();
    // The client name renders HTML-escaped (XSS defence for open-DCR names):
    // the raw `<Trading>` must never appear unescaped.
    expect(html).toContain("Example &lt;Trading&gt; Client");
    expect(html).not.toContain(CLIENT_NAME);
    expect(html).toContain(REDIRECT_URI);
    expect(html).toContain('type="hidden"');
    expect(html).toContain('name="csrf_token"');
  });

  test("unregistered redirect_uri is rejected before rendering", async () => {
    const provider = fakeProvider({
      authRequest: fakeAuthRequest({ redirectUri: "https://evil.example/cb" }),
      redirectUris: [REDIRECT_URI],
    });
    const res = await publicApp.request("/authorize", {}, testEnv(provider));

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).not.toContain('name="csrf_token"');
  });

  test("foreign resource parameter is rejected at consent time", async () => {
    const provider = fakeProvider({
      authRequest: fakeAuthRequest({
        resource: "https://attacker.example/mcp",
      }),
    });
    const res = await publicApp.request("/authorize", {}, testEnv(provider));

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).not.toContain('name="csrf_token"');
  });

  test("malformed authorize request is rejected with a clean 400", async () => {
    // The real provider throws OAuthError on malformed requests; the handler
    // must never reflect the thrown error's message/stack into the response.
    const provider = {
      async parseAuthRequest() {
        throw new Error("SECRET_STACK_DETAIL_xyz");
      },
      async lookupClient() {
        return null;
      },
    };
    const res = await publicApp.request("/authorize", {}, testEnv(provider));

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain("SECRET_STACK_DETAIL_xyz");
    expect(body).not.toContain('name="csrf_token"');
  });
});
