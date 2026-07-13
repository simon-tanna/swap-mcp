import { AppError } from "../errors";

/** The authenticated grant: user id, granted scopes, and token audience. */
export type AuthProps = { userId: string; scopes: string[]; resource: string };

/** Stable id of the single DB user; multi-user is a non-goal. */
export const SINGLE_USER_ID = "single-user";

/**
 * Cross-origin defense for the `/mcp` transport, applied BEFORE OAuth.
 *
 * The `Origin` header is a BROWSER-only signal: a DNS-rebinding / cross-site attack
 * necessarily originates from browser JavaScript, which always sends `Origin`. So we
 * validate `Origin` against the allowlist only WHEN it is present. Real remote MCP
 * clients (Claude/GPT/Grok connectors) run their HTTP client host-side and send NO
 * `Origin` header — those are authenticated by the bearer token, not by `Origin`, so
 * an absent `Origin` is allowed through. Requiring `Origin` to be present 403s every
 * legitimate connector (observed: `user-agent: Claude-User` requests carry no Origin).
 *
 * We do NOT gate on `MCP-Protocol-Version` here: per the MCP spec the server defaults
 * to `2025-03-26` when the header is absent (and the `initialize` request negotiates
 * the version via its body, not a pre-set header). The MCP transport owns version
 * handling; a hard presence check would reject spec-compliant clients.
 */
export function transportGuard(req: Request, allowedOrigins: string[]): void {
  const origin = req.headers.get("Origin");
  if (origin !== null && !allowedOrigins.includes(origin)) {
    throw new AppError("forbidden");
  }
}

/** Fail-closed audience check: the token's resource must equal the canonical MCP URI. */
export function assertAudience(
  props: Pick<AuthProps, "resource">,
  canonicalMcpUri: string,
): void {
  if (props.resource !== canonicalMcpUri) {
    throw new AppError("forbidden");
  }
}

/** Fail-closed scope gate; a missing/undefined scopes array is never treated as permissive. */
export function requireScope(
  props: Pick<AuthProps, "scopes">,
  scope: "swap:read" | "swap:write",
): void {
  if (!Array.isArray(props.scopes) || !props.scopes.includes(scope)) {
    throw new AppError("forbidden");
  }
}
