import { env, SELF } from "cloudflare:test";

/**
 * Drive the REAL production consent flow end-to-end through the worker (via
 * `SELF`, which routes to the `main` binding = `src/index.ts` default export)
 * and return an access token plus the client id it was minted for.
 *
 * This is the genuine OAuth 2.1 authorization-code + PKCE dance the deployed
 * server performs — open DCR, `GET /authorize` (scrape the CSRF token from the
 * consent HTML), `POST /authorize` with the passphrase + allowed Origin (follow
 * the 302 to extract the code), then exchange the code at `/token`. It never
 * mints anything narrower than both scopes: the consent flow hardcodes the
 * grant.
 */
export async function mintToken(): Promise<{
  accessToken: string;
  clientId: string;
}> {
  const origin = firstAllowedOrigin();
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const resource = env.CANONICAL_MCP_URI;

  // 1. Open dynamic client registration.
  const registerRes = await SELF.fetch("https://worker/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      client_name: "integration-test-client",
    }),
  });
  if (registerRes.status !== 201 && registerRes.status !== 200) {
    throw new Error(
      `DCR failed: ${registerRes.status} ${await registerRes.text()}`,
    );
  }
  const client = (await registerRes.json()) as { client_id: string };
  const clientId = client.client_id;

  // 2. PKCE: S256 challenge/verifier — public clients (auth method "none")
  // require PKCE under OAuth 2.1, which the provider enforces.
  const codeVerifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(codeVerifier),
      ),
    ),
  );

  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const authorizeQuery = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    resource,
    state,
    scope: "swap:read swap:write",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const authorizeUrl = `https://worker/authorize?${authorizeQuery.toString()}`;

  // 3a. GET the consent page and scrape the hidden CSRF token.
  const consentRes = await SELF.fetch(authorizeUrl, {
    headers: { Origin: origin },
  });
  if (consentRes.status !== 200) {
    throw new Error(
      `GET /authorize failed: ${consentRes.status} ${await consentRes.text()}`,
    );
  }
  const consentHtml = await consentRes.text();
  const csrfToken = scrapeCsrfToken(consentHtml);

  // 3b. POST consent with the same authorize query on the URL (the form action
  // preserves it), an allowed Origin, and an edge-populated client IP. The 302
  // Location carries the authorization code back on the redirect_uri.
  const consentPostRes = await SELF.fetch(authorizeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.7",
    },
    body: new URLSearchParams({
      csrf_token: csrfToken,
      passphrase: env.AUTH_PASSPHRASE as string,
    }).toString(),
    redirect: "manual",
  });
  if (consentPostRes.status !== 302) {
    throw new Error(
      `POST /authorize expected 302, got ${consentPostRes.status} ${await consentPostRes.text()}`,
    );
  }
  const location = consentPostRes.headers.get("Location");
  if (!location) {
    throw new Error("POST /authorize 302 had no Location header");
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) {
    throw new Error(`no authorization code in redirect: ${location}`);
  }

  // 4. Exchange the code for an access token (authorization_code + PKCE).
  const tokenRes = await SELF.fetch("https://worker/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (tokenRes.status !== 200) {
    throw new Error(
      `POST /token failed: ${tokenRes.status} ${await tokenRes.text()}`,
    );
  }
  const token = (await tokenRes.json()) as { access_token: string };
  if (!token.access_token) {
    throw new Error("token response had no access_token");
  }

  return { accessToken: token.access_token, clientId };
}

/** First entry of the wrangler `ALLOWED_ORIGINS` var — a guaranteed-allowed Origin. */
export function firstAllowedOrigin(): string {
  const raw = env.ALLOWED_ORIGINS as string;
  return raw.split(",")[0].trim();
}

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

/** Pull the single-use CSRF token out of the consent page's hidden input. */
function scrapeCsrfToken(html: string): string {
  const match = html.match(/name="csrf_token"\s+value="([^"]+)"/);
  if (!match) {
    throw new Error("could not find csrf_token in consent HTML");
  }
  return match[1];
}
