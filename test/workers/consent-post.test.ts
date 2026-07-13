/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SINGLE_USER_ID } from "../../src/auth/guards";
import { CURATED_MESSAGE } from "../../src/errors";
import {
  issueCsrfToken,
  verifyAndConsumeCsrfToken,
  type AuthRequestLike,
} from "../../src/oauth/csrf";
import { compareDeps, publicApp } from "../../src/oauth/publicApp";

/** Must equal `vars.CANONICAL_MCP_URI` in wrangler.jsonc (what validateEnv sees). */
const CANONICAL = "https://swap-mcp.simon-tanna.workers.dev";
const REDIRECT_URI = "https://client.example/callback";
/** First entry of `vars.ALLOWED_ORIGINS` in wrangler.jsonc. */
const ALLOWED_ORIGIN = "https://claude.ai";
/** Must equal the AUTH_PASSPHRASE test binding in vitest.config.ts. */
const PASSPHRASE = "test-auth-passphrase";
const REDIRECT_TO = `${REDIRECT_URI}?code=auth-code&state=opaque-state`;
const DEFAULT_IP = "203.0.113.1";

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

/** A fake OAUTH_PROVIDER binding with a spying `completeAuthorization`. */
function fakeProvider(authRequest: AuthRequestLike) {
  return {
    parseAuthRequest: vi.fn(async () => authRequest),
    lookupClient: vi.fn(async (clientId: string) => ({
      clientId,
      redirectUris: [REDIRECT_URI],
      clientName: "Example Client",
    })),
    completeAuthorization: vi.fn(
      async (_options: {
        request: AuthRequestLike;
        userId: string;
        metadata: Record<string, never>;
        scope: string[];
        props: { userId: string; scopes: string[]; resource: string };
      }) => ({ redirectTo: REDIRECT_TO }),
    ),
  };
}

/** Full workers-pool env (real OAUTH_KV, real RATE_LIMITER DO) plus the fake provider. */
function testEnv(provider: unknown) {
  return { ...env, OAUTH_PROVIDER: provider };
}

/** The single global RateLimiter instance the handler must address by fixed name. */
function limiterStub() {
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("global"));
}

interface PostOptions {
  origin?: string;
  referer?: string;
  csrf?: string;
  passphrase?: string;
  ip?: string;
  extraHeaders?: Record<string, string>;
}

/** POST the consent form with controllable headers and form fields. */
function postAuthorize(provider: unknown, opts: PostOptions = {}) {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });
  if (opts.origin !== undefined) headers.set("Origin", opts.origin);
  if (opts.referer !== undefined) headers.set("Referer", opts.referer);
  headers.set("CF-Connecting-IP", opts.ip ?? DEFAULT_IP);
  for (const [name, value] of Object.entries(opts.extraHeaders ?? {})) {
    headers.set(name, value);
  }
  const body = new URLSearchParams();
  if (opts.csrf !== undefined) body.set("csrf_token", opts.csrf);
  if (opts.passphrase !== undefined) body.set("passphrase", opts.passphrase);
  return publicApp.request(
    "/authorize",
    { method: "POST", headers, body },
    testEnv(provider),
  );
}

/** Spy on the timing-safe compare seam to prove early-reject paths never reach it. */
function spyOnCompare() {
  return vi.spyOn(compareDeps, "timingSafeEqualDigest");
}

// Every test shares the single fixed-name "global" DO instance the handler
// addresses, so wipe its windows between tests for deterministic budgets.
beforeEach(async () => {
  await runInDurableObject(limiterStub(), async (_instance, state) => {
    await state.storage.deleteAll();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publicApp POST /authorize", () => {
  test("POST with both Origin and Referer absent is rejected before CSRF and passphrase", async () => {
    const authRequest = fakeAuthRequest();
    const provider = fakeProvider(authRequest);
    const token = await issueCsrfToken(env.OAUTH_KV, authRequest);
    const compareSpy = spyOnCompare();

    const res = await postAuthorize(provider, {
      csrf: token,
      passphrase: PASSPHRASE,
    });

    expect(res.status).toBe(403);
    expect(compareSpy).not.toHaveBeenCalled();
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
    // Rejected BEFORE the CSRF gate: the nonce must still be intact.
    expect(
      await verifyAndConsumeCsrfToken(env.OAUTH_KV, token, authRequest),
    ).toBe(true);
  });

  test("disallowed Origin is rejected", async () => {
    const authRequest = fakeAuthRequest();
    const provider = fakeProvider(authRequest);
    const token = await issueCsrfToken(env.OAUTH_KV, authRequest);
    const compareSpy = spyOnCompare();

    const res = await postAuthorize(provider, {
      origin: "https://evil.example",
      csrf: token,
      passphrase: PASSPHRASE,
    });

    expect(res.status).toBe(403);
    expect(compareSpy).not.toHaveBeenCalled();
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });

  test("invalid or replayed csrf token is rejected before the passphrase is evaluated", async () => {
    const authRequest = fakeAuthRequest();
    const provider = fakeProvider(authRequest);
    const compareSpy = spyOnCompare();

    const res = await postAuthorize(provider, {
      origin: ALLOWED_ORIGIN,
      csrf: "not-a-real-token",
      passphrase: PASSPHRASE,
    });

    expect(res.status).toBe(403);
    expect(compareSpy).not.toHaveBeenCalled();
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });

  test("csrf nonce is consumed on every outcome and a replay is rejected", async () => {
    const authRequest = fakeAuthRequest();
    const provider = fakeProvider(authRequest);
    const token = await issueCsrfToken(env.OAUTH_KV, authRequest);

    // First submission fails the passphrase — but the nonce is still consumed.
    const first = await postAuthorize(provider, {
      origin: ALLOWED_ORIGIN,
      csrf: token,
      passphrase: "wrong-passphrase",
    });
    expect(first.status).toBe(200);

    // Replaying the same nonce — even with the CORRECT passphrase — is rejected.
    const compareSpy = spyOnCompare();
    const replay = await postAuthorize(provider, {
      origin: ALLOWED_ORIGIN,
      csrf: token,
      passphrase: PASSPHRASE,
    });
    expect(replay.status).toBe(403);
    expect(compareSpy).not.toHaveBeenCalled();
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });

  test("rate limiter is consulted before the passphrase compare and 429s when exhausted", async () => {
    const authRequest = fakeAuthRequest();
    const provider = fakeProvider(authRequest);
    const token = await issueCsrfToken(env.OAUTH_KV, authRequest);
    const stub = limiterStub();

    // Exhaust the per-IP failure budget (5) directly on the real DO.
    for (let i = 0; i < 5; i++) {
      expect(await stub.checkAndConsume(DEFAULT_IP)).toEqual({ allowed: true });
    }

    const compareSpy = spyOnCompare();
    const res = await postAuthorize(provider, {
      origin: ALLOWED_ORIGIN,
      csrf: token,
      passphrase: PASSPHRASE,
    });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: { code: "rate_limited", message: CURATED_MESSAGE.rate_limited },
    });
    expect(compareSpy).not.toHaveBeenCalled();
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });

  test("correct passphrase completes authorization with exact props", async () => {
    const authRequest = fakeAuthRequest();
    const provider = fakeProvider(authRequest);
    const token = await issueCsrfToken(env.OAUTH_KV, authRequest);

    const res = await postAuthorize(provider, {
      origin: ALLOWED_ORIGIN,
      csrf: token,
      passphrase: PASSPHRASE,
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(REDIRECT_TO);

    expect(provider.completeAuthorization).toHaveBeenCalledTimes(1);
    const options = provider.completeAuthorization.mock.calls[0]?.[0];
    expect(options).toEqual({
      request: authRequest,
      userId: SINGLE_USER_ID,
      metadata: {},
      // Scopes are hardcoded — never derived from the client's requested scope
      // (fixture requested ["swap"], granted scopes must ignore it).
      scope: ["swap:read", "swap:write"],
      props: {
        userId: SINGLE_USER_ID,
        scopes: ["swap:read", "swap:write"],
        resource: CANONICAL,
      },
    });
    // No secret material may ride along in props.
    expect(JSON.stringify(options?.props)).not.toContain(PASSPHRASE);

    // recordSuccess must have reset the per-IP window: the one reservation the
    // POST consumed is gone, so a full fresh per-IP budget of 5 is available.
    const stub = limiterStub();
    for (let i = 0; i < 5; i++) {
      expect(await stub.checkAndConsume(DEFAULT_IP)).toEqual({ allowed: true });
    }
  });

  test("wrong passphrase re-renders with error, mints nothing and consumes a failure", async () => {
    const authRequest = fakeAuthRequest();
    const provider = fakeProvider(authRequest);
    const token = await issueCsrfToken(env.OAUTH_KV, authRequest);

    const res = await postAuthorize(provider, {
      origin: ALLOWED_ORIGIN,
      csrf: token,
      passphrase: "wrong-passphrase",
    });

    // Re-rendered consent form with an error and a fresh CSRF field.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Incorrect passphrase");
    expect(body).toContain('name="csrf_token"');
    expect(body).toContain('name="passphrase"');

    // Mints nothing.
    expect(provider.completeAuthorization).not.toHaveBeenCalled();

    // The failure stays consumed (no recordSuccess): 4 more reservations fit,
    // the 6th overall is denied on the per-IP budget.
    const stub = limiterStub();
    for (let i = 0; i < 4; i++) {
      expect(await stub.checkAndConsume(DEFAULT_IP)).toEqual({ allowed: true });
    }
    expect(await stub.checkAndConsume(DEFAULT_IP)).toEqual({
      allowed: false,
      reason: "per_ip",
    });
  });

  test("IP is read only from CF-Connecting-IP", async () => {
    const authRequest = fakeAuthRequest();
    const provider = fakeProvider(authRequest);
    const exhaustedIp = "198.51.100.7";
    const freshIp = "198.51.100.8";
    const stub = limiterStub();
    for (let i = 0; i < 5; i++) {
      expect(await stub.checkAndConsume(exhaustedIp)).toEqual({
        allowed: true,
      });
    }

    // CF-Connecting-IP exhausted, X-Forwarded-For fresh: must 429 — proving the
    // spoofable X-Forwarded-For is never consulted.
    const tokenA = await issueCsrfToken(env.OAUTH_KV, authRequest);
    const limited = await postAuthorize(provider, {
      origin: ALLOWED_ORIGIN,
      csrf: tokenA,
      passphrase: PASSPHRASE,
      ip: exhaustedIp,
      extraHeaders: { "X-Forwarded-For": freshIp },
    });
    expect(limited.status).toBe(429);

    // CF-Connecting-IP fresh, X-Forwarded-For exhausted: must proceed.
    const tokenB = await issueCsrfToken(env.OAUTH_KV, authRequest);
    const allowed = await postAuthorize(provider, {
      origin: ALLOWED_ORIGIN,
      csrf: tokenB,
      passphrase: PASSPHRASE,
      ip: freshIp,
      extraHeaders: { "X-Forwarded-For": exhaustedIp },
    });
    expect(allowed.status).toBe(302);
  });
});
