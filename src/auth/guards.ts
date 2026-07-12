import { AppError } from "../errors";

/** Auth context carried by MCP `this.props` and REST middleware. */
export type AuthProps = { userId: string; scopes: string[]; resource: string };

/** Stable id of the single DB user; multi-user is a non-goal. */
export const SINGLE_USER_ID = "single-user";

/** Enforce the Origin allowlist and require an MCP-Protocol-Version header, before OAuth. */
export function transportGuard(req: Request, allowedOrigins: string[]): void {
  const origin = req.headers.get("Origin");
  if (origin === null || !allowedOrigins.includes(origin)) {
    throw new AppError("forbidden");
  }
  if (req.headers.get("MCP-Protocol-Version") === null) {
    throw new AppError("invalid_input");
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
