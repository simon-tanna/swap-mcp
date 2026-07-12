import { Hono } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

import { timingSafeEqualDigest } from "../auth/constantTime";
import { SINGLE_USER_ID, type AuthProps } from "../auth/guards";
import { validateEnv } from "../env";
import { CURATED_MESSAGE } from "../errors";
import {
  issueCsrfToken,
  verifyAndConsumeCsrfToken,
  type AuthRequestLike,
} from "./csrf";

/**
 * The OAuth helpers the consent flow depends on: parse the incoming auth
 * request, look up the registered client, and mint the grant. Injected by
 * OAuthProvider as the `OAUTH_PROVIDER` env binding (structurally a subset of
 * the provider's `OAuthHelpers`).
 */
interface OAuthProviderHelpers {
  parseAuthRequest(request: Request): Promise<AuthRequestLike>;
  lookupClient(
    clientId: string,
  ): Promise<{ redirectUris: string[]; clientName?: string } | null>;
  completeAuthorization(options: {
    request: AuthRequestLike;
    userId: string;
    metadata: Record<string, never>;
    scope: string[];
    props: AuthProps;
  }): Promise<{ redirectTo: string }>;
}

/** publicApp's env: KV for CSRF nonces, the canonical MCP URI var, and the OAuth helpers. */
type PublicEnv = CloudflareBindings & { OAUTH_PROVIDER: OAuthProviderHelpers };

/**
 * Injectable seam for the timing-safe passphrase compare. Defaults to the real
 * implementation; tests spy on this object to prove the compare is NEVER
 * reached on early-reject paths, without changing publicApp's public API.
 */
export const compareDeps = { timingSafeEqualDigest };

/**
 * Scopes granted on consent — hardcoded by design (spec §5.6, interview
 * decision 26) and NEVER derived from the client's requested scope, so a
 * client cannot request its way into a wider grant.
 */
const GRANTED_SCOPES = ["swap:read", "swap:write"] as const;

/** The single resource value carried by the request, or null if absent/multi-valued. */
function effectiveResource(
  resource: string | string[] | undefined,
): string | null {
  if (typeof resource === "string") {
    return resource;
  }
  if (Array.isArray(resource) && resource.length === 1) {
    return resource[0];
  }
  return null;
}

/**
 * Render the consent page. The form's `action` preserves the original
 * authorize query string so the POST can re-parse the same AuthRequest that
 * the embedded CSRF token was bound to at issue time.
 */
function renderConsentPage(opts: {
  clientName: string;
  redirectUri: string;
  action: string;
  csrfToken: string;
  errorMessage?: string;
}): HtmlEscapedString | Promise<HtmlEscapedString> {
  // `html` auto-escapes interpolated values; clientName and redirectUri are
  // attacker-influenceable (open DCR) so they must never be concatenated raw.
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Authorize access</title>
      </head>
      <body>
        <main>
          <h1>Authorize access</h1>
          <p>
            <strong>${opts.clientName}</strong> is requesting access and will be
            redirected to:
          </p>
          <p><code>${opts.redirectUri}</code></p>
          <p>
            Confirm this client name and redirect URL are ones you expect before
            entering the passphrase.
          </p>
          ${opts.errorMessage ? html`<p>${opts.errorMessage}</p>` : ""}
          <form method="post" action="${opts.action}">
            <input type="hidden" name="csrf_token" value="${opts.csrfToken}" />
            <label>
              Passphrase
              <input type="password" name="passphrase" autocomplete="off" />
            </label>
            <button type="submit">Authorize</button>
          </form>
        </main>
      </body>
    </html>`;
}

// publicApp is the OAuthProvider's PUBLIC (unauthenticated) handler.
// `/healthz` must be a CONSTANT response — it must never read env/bindings or
// branch on their presence, so it can't become an oracle that leaks whether a
// binding/secret is configured (spec §5.13, G1). Other routes here (e.g.
// `/authorize`) may read env.
export const publicApp = new Hono<{ Bindings: PublicEnv }>();

publicApp.get("/healthz", (c) => c.json({ status: "ok" }));

// §5.6b/§5.6/M12: render the consent screen. Strictly validate the redirect_uri
// against the registered client and the resource against CANONICAL_MCP_URI
// BEFORE rendering, then issue a single-use CSRF token bound to the request and
// embed it as a hidden field. The client name and exact redirect_uri are shown
// above the passphrase field as the operator's out-of-band phishing check.
publicApp.get("/authorize", async (c) => {
  // The provider throws OAuthError on malformed authorize requests (bad
  // client_id, redirect_uri, response_type, etc.). Since this endpoint is
  // unauthenticated and attacker-reachable, catch and return a static 400 —
  // never let the exception message/stack reach the response body.
  let authRequest: AuthRequestLike;
  let client: { redirectUris: string[]; clientName?: string } | null;
  try {
    authRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    client = await c.env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  } catch {
    return c.text("Invalid authorization request.", 400);
  }

  if (client === null) {
    return c.text("Invalid client.", 400);
  }
  if (!client.redirectUris.includes(authRequest.redirectUri)) {
    return c.text("Unregistered redirect_uri.", 400);
  }
  if (effectiveResource(authRequest.resource) !== c.env.CANONICAL_MCP_URI) {
    return c.text("Invalid resource.", 400);
  }

  const csrfToken = await issueCsrfToken(c.env.OAUTH_KV, authRequest);

  return c.html(
    renderConsentPage({
      clientName: client.clientName ?? authRequest.clientId,
      redirectUri: authRequest.redirectUri,
      // Preserve the original OAuth query verbatim so the POST re-parses the
      // exact AuthRequest this CSRF token was bound to.
      action: `/authorize${new URL(c.req.url).search}`,
      csrfToken,
    }),
  );
});

// §5.6: consent submission. A STRICT ordered gate chain — each gate exists to
// stop later, more expensive/leaky work from ever running on a bad request:
// 1. Origin/Referer presence  2. Origin allowlist  3. parse AuthRequest
// 4. CSRF verify+consume      5. resource check    6. rate limiter
// 7. timing-safe passphrase compare  8/9. mint-and-redirect or re-render.
publicApp.post("/authorize", async (c) => {
  // Gate 1: both Origin and Referer absent → 403 before anything else. The
  // Origin allowlist is the load-bearing cross-site control (the CSRF token is
  // replay protection, not session-binding), so a source-less POST is dead on
  // arrival.
  const origin = c.req.header("Origin");
  const referer = c.req.header("Referer");
  if (origin === undefined && referer === undefined) {
    return c.text("Forbidden.", 403);
  }

  const validated = validateEnv(c.env);

  // Gate 2: strict allowlist on the request's source origin — the Origin
  // header when present, otherwise the Referer's origin (unparseable → reject).
  if (origin !== undefined) {
    if (!validated.allowedOrigins.includes(origin)) {
      return c.text("Forbidden.", 403);
    }
  } else {
    let refererOrigin: string;
    try {
      refererOrigin = new URL(referer as string).origin;
    } catch {
      return c.text("Forbidden.", 403);
    }
    if (!validated.allowedOrigins.includes(refererOrigin)) {
      return c.text("Forbidden.", 403);
    }
  }

  // Gate 3: re-parse the AuthRequest from the preserved query string. Same
  // no-leak posture as the GET: static 400, never the thrown error's text.
  let authRequest: AuthRequestLike;
  try {
    authRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch {
    return c.text("Invalid authorization request.", 400);
  }

  // Gate 4: CSRF verify + consume (delete-on-read: the nonce is spent on ANY
  // outcome). Runs BEFORE the rate limiter and passphrase compare so a forged
  // or replayed submission can neither burn rate-limit budget for a victim IP
  // nor exercise the compare at all.
  const body = await c.req.parseBody();
  const csrfToken = body["csrf_token"];
  if (
    typeof csrfToken !== "string" ||
    !(await verifyAndConsumeCsrfToken(c.env.OAUTH_KV, csrfToken, authRequest))
  ) {
    return c.text("Forbidden.", 403);
  }

  // Gate 5: defense-in-depth resource check (the CSRF binding already covers
  // tamper, but the grant must never be minted for a foreign resource).
  if (effectiveResource(authRequest.resource) !== validated.canonicalMcpUri) {
    return c.text("Invalid resource.", 400);
  }

  // Gate 6: consult the rate limiter BEFORE the compare — checkAndConsume
  // reserves a failure up front (fail-safe-closed), so an exhausted IP gets a
  // 429 without the passphrase ever being evaluated. The IP comes ONLY from
  // CF-Connecting-IP (edge-populated, not client-spoofable) — never
  // X-Forwarded-For.
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const stub = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName("global"));
  const rl = await stub.checkAndConsume(ip);
  if (!rl.allowed) {
    return c.json(
      {
        error: { code: "rate_limited", message: CURATED_MESSAGE.rate_limited },
      },
      429,
    );
  }

  // Gate 7: SHA-256-then-timingSafeEqual compare, via the injectable seam.
  const passphrase = body["passphrase"];
  const matches = await compareDeps.timingSafeEqualDigest(
    typeof passphrase === "string" ? passphrase : "",
    validated.getAuthPassphrase(),
  );

  if (!matches) {
    // Mismatch: the checkAndConsume reservation stays consumed (the failure
    // counts against the budget) and nothing is minted. Re-render the consent
    // form with a fresh single-use CSRF token so the operator can retry.
    const freshToken = await issueCsrfToken(c.env.OAUTH_KV, authRequest);
    let clientName = authRequest.clientId;
    try {
      const client = await c.env.OAUTH_PROVIDER.lookupClient(
        authRequest.clientId,
      );
      if (client?.clientName) {
        clientName = client.clientName;
      }
    } catch {
      // Display fallback only — the retry still passes every gate on submit.
    }
    return c.html(
      renderConsentPage({
        clientName,
        redirectUri: authRequest.redirectUri,
        action: `/authorize${new URL(c.req.url).search}`,
        csrfToken: freshToken,
        errorMessage: "Incorrect passphrase. Please try again.",
      }),
    );
  }

  // Gate 8: mint the grant. props carry EXACTLY { userId, scopes, resource } —
  // no passphrase/key/secret material ever rides into token props.
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: SINGLE_USER_ID,
    metadata: {},
    scope: [...GRANTED_SCOPES],
    props: {
      userId: SINGLE_USER_ID,
      scopes: [...GRANTED_SCOPES],
      resource: validated.canonicalMcpUri,
    },
  });
  // Success only: reset the per-IP window so a correct passphrase does not
  // cost failure budget; mismatches deliberately never reach this line.
  await stub.recordSuccess(ip);
  return c.redirect(redirectTo, 302);
});
