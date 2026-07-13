/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import { SINGLE_USER_ID } from "../../src/auth/guards";
import type { SwapCoordinator } from "../../src/coordinator/SwapCoordinator";
import * as schema from "../../src/db/schema";
import { swaps } from "../../src/db/schema";
import type { RateLimiter } from "../../src/ratelimit/RateLimiter";
import { createTransactionsRepository } from "../../src/repository/transactions";
import { getQuote } from "../../src/services/swapService";
import {
  fakeSigner,
  fakeTradingApi,
  makeDeps,
} from "../workers/helpers/coordinatorFakes";
import { firstAllowedOrigin, mintToken } from "../helpers/mintToken";

/**
 * Integration NEGATIVE paths for the wired worker (`src/index.ts` default
 * export) driven through `SELF` (the real `main` binding = the OAuthProvider),
 * and for the mid-swap half through the real `SWAP_COORDINATOR` Durable Object
 * with a parked fake signer. The production consent flow always grants BOTH
 * scopes, so read-only write-path rejection is proven separately at the
 * app-owned seam (scope-seam.test.ts).
 */

/** A supported MCP protocol version the streamable-HTTP transport accepts. */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/** The canonical worker origin the token's audience is minted for. */
function workerBase(): string {
  return new URL(env.CANONICAL_MCP_URI).origin;
}

/** The single global RateLimiter instance the consent handler addresses by fixed name. */
function limiterStub(): DurableObjectStub<RateLimiter> {
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("global"));
}

/** Pin the RateLimiter DO's injectable clock to a fixed millisecond instant. */
async function setLimiterClock(ms: number): Promise<void> {
  await runInDurableObject(limiterStub(), (instance: RateLimiter) => {
    instance.now = () => ms;
  });
}

// Each test starts from a clean RateLimiter (single fixed-name instance) and a
// clean swaps table so budgets and rows are deterministic.
beforeEach(async () => {
  await runInDurableObject(limiterStub(), async (_instance, state) => {
    await state.storage.deleteAll();
  });
  const db = drizzle(env.DB, { schema });
  await db.delete(swaps);
});

/**
 * Register a fresh DCR client and return its id, the PKCE pair, and the
 * authorize URL — the front half of the consent dance, so negative tests can
 * intercept between GET and POST /authorize.
 */
async function beginAuthorize(
  overrides: {
    resource?: string;
    // Redirect URIs registered at DCR time. Defaults to the single canonical
    // Claude web callback.
    registeredRedirectUris?: string[];
    // The redirect_uri sent on the authorize request. Defaults to the first
    // registered URI (the matching happy-path case). Set to a DIFFERENT value
    // than what was registered to exercise the provider's redirect_uri matching.
    authorizeRedirectUri?: string;
  } = {},
): Promise<{
  clientId: string;
  codeVerifier: string;
  authorizeUrl: string;
  redirectUri: string;
}> {
  const registeredRedirectUris = overrides.registeredRedirectUris ?? [
    "https://claude.ai/api/mcp/auth_callback",
  ];
  const redirectUri =
    overrides.authorizeRedirectUri ?? registeredRedirectUris[0];
  const registerRes = await SELF.fetch("https://worker/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: registeredRedirectUris,
      token_endpoint_auth_method: "none",
      client_name: "negative-test-client",
    }),
  });
  const client = (await registerRes.json()) as { client_id: string };

  const codeVerifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(codeVerifier),
      ),
    ),
  );
  const authorizeQuery = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    resource: overrides.resource ?? env.CANONICAL_MCP_URI,
    state: base64Url(crypto.getRandomValues(new Uint8Array(16))),
    scope: "swap:read swap:write",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    clientId: client.client_id,
    codeVerifier,
    authorizeUrl: `https://worker/authorize?${authorizeQuery.toString()}`,
    redirectUri,
  };
}

/** GET the consent page and scrape the hidden CSRF token from its form. */
async function fetchCsrf(
  authorizeUrl: string,
  origin: string,
): Promise<string> {
  const res = await SELF.fetch(authorizeUrl, { headers: { Origin: origin } });
  const html = await res.text();
  const match = html.match(/name="csrf_token"\s+value="([^"]+)"/);
  if (!match) {
    throw new Error("could not find csrf_token in consent HTML");
  }
  return match[1];
}

describe("OAuthProvider integration negative paths", () => {
  test("consent POST without a valid csrf token is rejected before passphrase evaluation", async () => {
    const origin = firstAllowedOrigin();
    const { authorizeUrl } = await beginAuthorize();
    // Warm the consent page so the form/nonce machinery is exercised, but POST a
    // bogus csrf token: the CSRF gate rejects before the passphrase is compared.
    await fetchCsrf(authorizeUrl, origin);

    const bad = await SELF.fetch(authorizeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Origin: origin,
        "CF-Connecting-IP": "203.0.113.20",
      },
      body: new URLSearchParams({
        csrf_token: "not-a-real-token",
        passphrase: env.AUTH_PASSPHRASE as string,
      }).toString(),
      redirect: "manual",
    });
    expect(bad.status).toBe(403);

    // A subsequent full GET+valid dance still mints a token — the operator is
    // not locked out by the rejected attempt.
    const { accessToken } = await mintToken();
    expect(typeof accessToken).toBe("string");
    expect(accessToken.length).toBeGreaterThan(0);
  });

  test("foreign resource at authorize is rejected", async () => {
    const origin = firstAllowedOrigin();
    const { authorizeUrl } = await beginAuthorize({
      resource: "https://attacker.example/mcp",
    });

    // GET /authorize for a foreign resource is rejected outright: no consent
    // form (hence no CSRF nonce) is ever rendered, so no code can be minted.
    const res = await SELF.fetch(authorizeUrl, {
      headers: { Origin: origin },
    });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(302);
    const html = await res.text();
    expect(html).not.toContain("csrf_token");

    // The legitimate-resource dance from the same client still mints a token —
    // the rejection is scoped to the foreign resource, not a blanket lockout.
    const { accessToken } = await mintToken();
    expect(accessToken.length).toBeGreaterThan(0);
  });

  test("a same-origin but path-scoped resource (origin + /mcp) is still rejected at authorize", async () => {
    const origin = firstAllowedOrigin();
    // This is the exact pre-fix production failure: the provider's PATH-SCOPED
    // protected-resource metadata advertised `<origin>/mcp`, so Claude sent THAT
    // as its `resource`. The fix pins `resourceMetadata.resource` to the origin so
    // a spec-compliant client discovers and sends the ORIGIN — it does NOT loosen
    // this gate. Regression-guard that a path-scoped resource on our own origin is
    // still rejected outright (no consent form, no CSRF nonce, so no code can mint).
    const { authorizeUrl } = await beginAuthorize({
      resource: `${workerBase()}/mcp`,
    });

    const res = await SELF.fetch(authorizeUrl, { headers: { Origin: origin } });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Invalid resource");
    expect(html).not.toContain("csrf_token");

    // The legitimate origin-resource dance from the same client still mints a
    // token — the rejection is scoped to the path-scoped resource, not a lockout.
    const { accessToken } = await mintToken();
    expect(accessToken.length).toBeGreaterThan(0);
  });

  test("a trailing-slash origin resource (the client's normalized form) is accepted", async () => {
    const origin = firstAllowedOrigin();
    // The REAL Claude connector normalizes the origin it discovers from PRM:
    // `new URL("https://host").href` → "https://host/". `CANONICAL_MCP_URI` is
    // stored WITHOUT the trailing slash, so a raw string compare 400s this. The
    // consent gate compares by normalized URL form, so the trailing-slash form is
    // accepted and the consent page renders.
    const { authorizeUrl } = await beginAuthorize({
      resource: `${workerBase()}/`,
    });

    const res = await SELF.fetch(authorizeUrl, { headers: { Origin: origin } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("csrf_token");
  });

  test("a loopback redirect_uri authorized from a different port reaches consent (RFC 8252)", async () => {
    const origin = firstAllowedOrigin();
    // A native-app harness (e.g. Claude Code) registers a loopback callback at
    // DCR time, then spins up a FRESH ephemeral port for the actual authorize
    // request. Per RFC 8252 §7.3 the provider matches loopback URIs ignoring the
    // port, so this must reach the consent page — not be rejected as an
    // unregistered redirect_uri.
    const { authorizeUrl } = await beginAuthorize({
      registeredRedirectUris: ["http://localhost:49001/callback"],
      authorizeRedirectUri: "http://localhost:52777/callback",
    });

    const res = await SELF.fetch(authorizeUrl, { headers: { Origin: origin } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("csrf_token");
  });

  test("a foreign (non-loopback) unregistered redirect_uri is still rejected", async () => {
    const origin = firstAllowedOrigin();
    // Loosening the app-owned shadow-check does NOT open a redirect hole: the
    // provider still requires a non-loopback redirect_uri to match a registered
    // one exactly. A foreign callback never reaches consent (no CSRF nonce), so
    // no code can be minted for it.
    const { authorizeUrl } = await beginAuthorize({
      registeredRedirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      authorizeRedirectUri: "https://evil.example/callback",
    });

    const res = await SELF.fetch(authorizeUrl, { headers: { Origin: origin } });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(302);
    expect(await res.text()).not.toContain("csrf_token");
  });

  test("POST /mcp with a disallowed Origin is rejected before dispatch", async () => {
    const { accessToken } = await mintToken();
    const res = await SELF.fetch(`${workerBase()}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        Origin: "https://evil.example",
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
    // transportGuard rejects the disallowed Origin BEFORE any tool dispatch.
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("forbidden");
  });

  test("POST /mcp initialize from a server-side client (no Origin, no MCP-Protocol-Version) is accepted", async () => {
    const { accessToken } = await mintToken();
    // The real remote-connector shape captured from Claude (ua "Claude-User"): a
    // host-side HTTP client that sends NO Origin header and no pre-set
    // MCP-Protocol-Version. transportGuard must let this through — the bearer token
    // is the authentication — and the MCP transport must negotiate the version from
    // the initialize body. Requiring Origin/version here 403/400s every connector.
    const res = await SELF.fetch(`${workerBase()}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        Accept: "application/json, text/event-stream",
        // Deliberately NO Origin and NO MCP-Protocol-Version header.
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
    // Not a guard rejection (would be 403 forbidden / 400 invalid_input): the
    // transport handles the initialize and returns a JSON-RPC result.
    expect(res.status).toBe(200);
  });

  test("sixth failed passphrase from one IP returns 429", async () => {
    const origin = firstAllowedOrigin();
    const ip = "9.9.9.9";
    await setLimiterClock(1_700_000_000_000);

    // Five wrong-passphrase POSTs consume the per-IP budget (each with its own
    // fresh single-use CSRF nonce).
    for (let i = 0; i < 5; i++) {
      const { authorizeUrl } = await beginAuthorize();
      const csrf = await fetchCsrf(authorizeUrl, origin);
      const res = await SELF.fetch(authorizeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          Origin: origin,
          "CF-Connecting-IP": ip,
        },
        body: new URLSearchParams({
          csrf_token: csrf,
          passphrase: "wrong-passphrase",
        }).toString(),
        redirect: "manual",
      });
      // Wrong passphrase re-renders the consent form (200), consuming a failure.
      expect(res.status).toBe(200);
    }

    // The sixth attempt from the same IP is denied on the rate limit.
    const { authorizeUrl } = await beginAuthorize();
    const csrf = await fetchCsrf(authorizeUrl, origin);
    const sixth = await SELF.fetch(authorizeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Origin: origin,
        "CF-Connecting-IP": ip,
      },
      body: new URLSearchParams({
        csrf_token: csrf,
        passphrase: env.AUTH_PASSPHRASE as string,
      }).toString(),
      redirect: "manual",
    });
    expect(sixth.status).toBe(429);
    expect((await sixth.json()) as { error: { code: string } }).toEqual({
      error: {
        code: "rate_limited",
        message: "Too many requests; please retry later.",
      },
    });
  });

  test("429 recovers after the rate-limit window expires", async () => {
    const origin = firstAllowedOrigin();
    const ip = "9.9.9.9";
    const t0 = 1_700_000_000_000;
    await setLimiterClock(t0);

    // Exhaust the per-IP budget with five failures.
    for (let i = 0; i < 5; i++) {
      const { authorizeUrl } = await beginAuthorize();
      const csrf = await fetchCsrf(authorizeUrl, origin);
      await SELF.fetch(authorizeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          Origin: origin,
          "CF-Connecting-IP": ip,
        },
        body: new URLSearchParams({
          csrf_token: csrf,
          passphrase: "wrong-passphrase",
        }).toString(),
        redirect: "manual",
      });
    }

    // Sixth is 429 while still inside the window.
    {
      const { authorizeUrl } = await beginAuthorize();
      const csrf = await fetchCsrf(authorizeUrl, origin);
      const blocked = await SELF.fetch(authorizeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          Origin: origin,
          "CF-Connecting-IP": ip,
        },
        body: new URLSearchParams({
          csrf_token: csrf,
          passphrase: env.AUTH_PASSPHRASE as string,
        }).toString(),
        redirect: "manual",
      });
      expect(blocked.status).toBe(429);
    }

    // Advance the injected clock past the 10-minute window: the same IP with the
    // correct passphrase now mints a token again — the operator is not
    // permanently locked out.
    await setLimiterClock(t0 + 600_000);
    const { authorizeUrl } = await beginAuthorize();
    const csrf = await fetchCsrf(authorizeUrl, origin);
    const recovered = await SELF.fetch(authorizeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Origin: origin,
        "CF-Connecting-IP": ip,
      },
      body: new URLSearchParams({
        csrf_token: csrf,
        passphrase: env.AUTH_PASSPHRASE as string,
      }).toString(),
      redirect: "manual",
    });
    expect(recovered.status).toBe(302);
    expect(recovered.headers.get("Location")).toContain("code=");
  });

  test("minted token props carry no secret", async () => {
    const { accessToken } = await mintToken();
    // Read a transactions row's echoed identity: userId is exposed, but neither
    // the passphrase nor any secret-name value rides along.
    const res = await SELF.fetch(`${workerBase()}/api/transactions`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(await res.json());
    expect(serialized).not.toContain(env.AUTH_PASSPHRASE as string);
    expect(serialized).not.toContain(env.SWAP_PRIVATE_KEY as string);
    expect(serialized).not.toContain(env.UNISWAP_API_KEY as string);
  });

  test("redaction leak test end-to-end", async () => {
    const { accessToken } = await mintToken();
    // Force an `internal` error: a non-numeric `limit` is `invalid_input`, but a
    // tampered cursor drives the repo to throw; either way the curated envelope
    // must never carry a long hex run or any secret-name value.
    const res = await SELF.fetch(
      `${workerBase()}/api/transactions?cursor=tampered-cursor-value`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const bodyText = await res.text();
    // No long hex run (private key / rpc secret) leaks into any error body.
    expect(/[0-9a-fA-F]{40,}/.test(bodyText)).toBe(false);
    expect(bodyText).not.toContain(env.SWAP_PRIVATE_KEY as string);
    expect(bodyText).not.toContain(env.AUTH_PASSPHRASE as string);
    expect(bodyText).not.toContain(env.UNISWAP_API_KEY as string);
    // The RPC URL host (a non-`0x` secret path) must not leak either.
    expect(bodyText).not.toContain("rpc.example");
  });

  test("REST mid-swap visibility shows submitted before the swap resolves", async () => {
    const { accessToken } = await mintToken();
    const parkedHash =
      "0xdeadbeef00000000000000000000000000000000000000000000000000000000";

    const coordinatorId = env.SWAP_COORDINATOR.idFromName(SINGLE_USER_ID);
    const coordinatorStub = env.SWAP_COORDINATOR.get(coordinatorId);

    // Park the coordinator's engine inside waitForReceipt: the row is written
    // `submitted` (with txHash) eagerly, but the swap POST cannot resolve until
    // a release flag flips. The flag is a plain field on the DO instance, so the
    // awaiting signer (running in the coordinator's own fetch context) and the
    // later flip (a second runInDurableObject on the SAME DO) share one context —
    // never bridging a promise across DO/isolate boundaries, which would trip the
    // "I/O on behalf of a different Durable Object" guard.
    await runInDurableObject(coordinatorStub, (instance: SwapCoordinator) => {
      const held = instance as SwapCoordinator & { __release?: boolean };
      held.__release = false;
      const repo = createTransactionsRepository(drizzle(env.DB, { schema }));
      instance.deps = makeDeps(
        fakeSigner({
          async sendTransaction() {
            return parkedHash;
          },
          async waitForReceipt() {
            // Yield across microtasks until the test flips the release flag.
            while (!held.__release) {
              await new Promise((r) => setTimeout(r, 5));
            }
            return { kind: "success", gasUsed: 21000n };
          },
        }),
        repo,
        fakeTradingApi(),
      );
    });

    // Fire POST /api/swap UNAWAITED through the full worker.
    const swapPromise = SELF.fetch(`${workerBase()}/api/swap`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        direction: "ETH_TO_USDC",
        amountIn: "1000000000000000000",
      }),
    });

    let swapSettled = false;
    void swapPromise.then(() => {
      swapSettled = true;
    });

    // Poll the DB for the mid-flight submitted row: its appearance is the
    // rendezvous (no cross-context promise), proving the eager markSubmitted
    // write is live-visible before the swap resolves.
    const db = drizzle(env.DB, { schema });
    let rowId: string | undefined;
    for (let i = 0; i < 200 && !rowId; i++) {
      const rows = await db.query.swaps.findMany({
        where: eq(swaps.txHash, parkedHash),
      });
      if (rows.length === 1) {
        rowId = rows[0].id;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(rowId).toBeDefined();

    try {
      const midRes = await SELF.fetch(
        `${workerBase()}/api/transactions/${rowId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      expect(midRes.status).toBe(200);
      const midRow = (await midRes.json()) as {
        status: string;
        txHash: string | null;
      };
      expect(midRow.status).toBe("submitted");
      expect(midRow.txHash).toBe(parkedHash);
      // The swap POST has NOT resolved yet — the row is live-visible mid-flight.
      expect(swapSettled).toBe(false);
    } finally {
      // Flip the release flag inside the SAME DO context so the parked signer
      // unblocks; kept in finally so the swap promise is never left pending.
      await runInDurableObject(coordinatorStub, (instance: SwapCoordinator) => {
        (instance as SwapCoordinator & { __release?: boolean }).__release =
          true;
      });
    }

    // The swap POST now resolves terminally.
    const swapRes = await swapPromise;
    expect(swapRes.status).toBe(200);
    const swapBody = (await swapRes.json()) as { status: string };
    expect(swapBody.status).toBe("confirmed");
  });

  test("get_quote output is accepted verbatim as expectedAmountOut", async () => {
    const { accessToken } = await mintToken();
    const origin = firstAllowedOrigin();

    // Compute a get_quote result the same way the tool does — the real service
    // `getQuote` over the classic trading-API fixture — and reuse its
    // `quotedAmountOut` byte-identically as execute_swap's expectedAmountOut. The
    // integration surfaces build their trading-API client from env (the real
    // Uniswap host, unreachable in tests), so the execute path is driven through
    // the injected coordinator DO seeded with the SAME fixture client, keeping
    // the reused floor byte-consistent end-to-end.
    const tradingApi = fakeTradingApi();
    const quote = await getQuote(
      { tradingApi },
      {
        direction: "ETH_TO_USDC",
        amountIn: "1000000000000000000",
      },
    );
    const reusedFloor = quote.quotedAmountOut;
    expect(typeof reusedFloor).toBe("string");
    expect(reusedFloor.length).toBeGreaterThan(0);

    // Seed the single-user coordinator DO with the same fixture trading-API and
    // a straight-through signer so the write path resolves without real network.
    const coordinatorId = env.SWAP_COORDINATOR.idFromName(SINGLE_USER_ID);
    const coordinatorStub = env.SWAP_COORDINATOR.get(coordinatorId);
    await runInDurableObject(coordinatorStub, (instance: SwapCoordinator) => {
      const repo = createTransactionsRepository(drizzle(env.DB, { schema }));
      instance.deps = makeDeps(fakeSigner(), repo, fakeTradingApi());
    });

    const initRes = await SELF.fetch(`${workerBase()}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        Origin: origin,
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
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("Mcp-Session-Id") ?? undefined;

    const callRes = await SELF.fetch(`${workerBase()}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        Origin: origin,
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "execute_swap",
          arguments: {
            direction: "ETH_TO_USDC",
            amountIn: "1000000000000000000",
            expectedAmountOut: reusedFloor,
          },
        },
      }),
    });
    expect(callRes.status).toBe(200);
    const result = await parseRpcResult(callRes);
    const structured = (
      result?.result as
        | {
            structuredContent?: {
              error?: { code?: string };
              status?: string;
            };
          }
        | undefined
    )?.structuredContent;

    // Byte-identical reuse is a VALID input: the tool did not refuse the reused
    // floor with invalid_input, and the swap settled terminally (no drift, since
    // the floor equals the quote it came from).
    expect(structured?.error?.code).not.toBe("invalid_input");
    expect(structured?.status).toBe("confirmed");
  });
});

/** URL-safe base64 (no padding) of raw bytes, per RFC 7636 PKCE encoding. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Parse a JSON-RPC result body from a JSON or SSE-framed MCP response. */
async function parseRpcResult(
  response: Response,
): Promise<{ result?: unknown; error?: unknown } | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (text.length === 0) return undefined;
  if (contentType.includes("text/event-stream")) {
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
