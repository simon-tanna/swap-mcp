import { Hono } from "hono";
import { html } from "hono/html";

import { issueCsrfToken, type AuthRequestLike } from "./csrf";

/**
 * The OAuth helpers the consent GET depends on: parse the incoming auth request
 * and look up the registered client. Injected by OAuthProvider as the
 * `OAUTH_PROVIDER` env binding (structurally a subset of the provider's
 * `OAuthHelpers`).
 */
interface OAuthProviderHelpers {
  parseAuthRequest(request: Request): Promise<AuthRequestLike>;
  lookupClient(
    clientId: string,
  ): Promise<{ redirectUris: string[]; clientName?: string } | null>;
}

/** publicApp's env: KV for CSRF nonces, the canonical MCP URI var, and the OAuth helpers. */
type PublicEnv = CloudflareBindings & { OAUTH_PROVIDER: OAuthProviderHelpers };

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
  const authRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const client = await c.env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);

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
  const clientName = client.clientName ?? authRequest.clientId;

  // `html` auto-escapes interpolated values; clientName and redirectUri are
  // attacker-influenceable (open DCR) so they must never be concatenated raw.
  return c.html(
    html`<!doctype html>
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
              <strong>${clientName}</strong> is requesting access and will be
              redirected to:
            </p>
            <p><code>${authRequest.redirectUri}</code></p>
            <p>
              Confirm this client name and redirect URL are ones you expect
              before entering the passphrase.
            </p>
            <form method="post" action="/authorize">
              <input type="hidden" name="csrf_token" value="${csrfToken}" />
              <label>
                Passphrase
                <input type="password" name="passphrase" autocomplete="off" />
              </label>
              <button type="submit">Authorize</button>
            </form>
          </main>
        </body>
      </html>`,
  );
});
