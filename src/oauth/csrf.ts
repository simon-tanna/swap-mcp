/**
 * The subset of the parsed OAuth `AuthRequest` a CSRF token is bound to. Kept
 * minimal and stable: `clientId`, `redirectUri`, and `resource` are the
 * security-relevant identifiers a token must not be replayed across; `scope`
 * and `state` are included so a token also binds the exact grant it was issued
 * for. `AuthRequest` from `@cloudflare/workers-oauth-provider` structurally
 * satisfies this type.
 */
export interface AuthRequestLike {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  resource?: string | string[];
}

/** KV key namespace for stored CSRF nonces, so they can't collide with other keys. */
const CSRF_KEY_PREFIX = "csrf:";

/** Short lifetime (seconds) of a consent CSRF token — long enough to fill a form, no longer. */
const CSRF_TTL_SECONDS = 600;

/** Canonical, order-stable JSON of the bound AuthRequest subset for hashing. */
function canonicalize(authRequest: AuthRequestLike): string {
  const resource = Array.isArray(authRequest.resource)
    ? [...authRequest.resource].sort()
    : (authRequest.resource ?? null);
  return JSON.stringify({
    clientId: authRequest.clientId,
    redirectUri: authRequest.redirectUri,
    scope: [...authRequest.scope].sort(),
    state: authRequest.state,
    resource,
  });
}

/** SHA-256 hex digest of the canonicalized AuthRequest subset. */
async function hashAuthRequest(authRequest: AuthRequestLike): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(authRequest));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Issues a single-use CSRF token bound to `authRequest`, storing the request's
 * hash in `kv` under a token-derived key with a 600s TTL, and returns the token
 * to embed as a hidden consent-form field.
 */
export async function issueCsrfToken(
  kv: KVNamespace,
  authRequest: AuthRequestLike,
): Promise<string> {
  const token = crypto.randomUUID();
  const hash = await hashAuthRequest(authRequest);
  await kv.put(CSRF_KEY_PREFIX + token, hash, {
    expirationTtl: CSRF_TTL_SECONDS,
  });
  return token;
}

/**
 * Verifies `token` against `authRequest` and consumes it (delete-on-read):
 * returns true only when the token exists and its stored hash matches the
 * current request's hash; the key is deleted regardless, so replays and
 * cross-request reuse both fail.
 */
export async function verifyAndConsumeCsrfToken(
  kv: KVNamespace,
  token: string,
  authRequest: AuthRequestLike,
): Promise<boolean> {
  const key = CSRF_KEY_PREFIX + token;
  const stored = await kv.get(key);
  if (stored === null) {
    return false;
  }
  await kv.delete(key);
  const expected = await hashAuthRequest(authRequest);
  return stored === expected;
}
