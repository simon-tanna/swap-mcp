import { assertAudience, requireScope } from "../../auth/guards";
import {
  classify,
  toErrorEnvelope,
  type ErrorCode,
  type ErrorEnvelope,
} from "../../errors";
import type { ToolDeps } from "./deps";

/** A successful tool result: human-readable text plus machine-readable structure. */
export type ToolSuccess = {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
};

/**
 * Curated, caller-safe messages for every code these read tools can surface.
 * `toErrorEnvelope` additionally scrubs hex, but the base text here never
 * embeds a raw upstream error string, so nothing internal leaks.
 */
const CURATED_MESSAGE: Record<ErrorCode, string> = {
  invalid_input: "The request was malformed or out of range.",
  unauthorized: "Authentication is required.",
  forbidden: "The caller is not permitted to perform this action.",
  not_found: "No matching record was found.",
  slippage_exceeded: "The quoted price moved beyond the allowed tolerance.",
  insufficient_balance: "The wallet balance is insufficient for this swap.",
  approval_required: "A token approval is required before this swap.",
  upstream_unavailable: "An upstream service is temporarily unavailable.",
  rate_limited: "Too many requests; please retry later.",
  swap_failed: "The swap did not complete successfully.",
  internal: "An unexpected internal error occurred.",
};

/**
 * Run a read tool's body behind the per-tool audience + scope gates (Major 4:
 * audience is enforced on every tool, not only at the transport). Any throw —
 * from a gate or the work itself — is mapped through {@link classify} to an
 * allowlisted code and returned as a {@link toErrorEnvelope}, so failures
 * resolve as ordinary tool results (`isError:true`), never as thrown errors.
 */
export async function guarded(
  deps: ToolDeps,
  scope: "swap:read" | "swap:write",
  work: () => Promise<ToolSuccess>,
): Promise<ToolSuccess | ErrorEnvelope> {
  try {
    const props = deps.getProps();
    assertAudience(props, deps.canonicalMcpUri);
    requireScope(props, scope);
    return await work();
  } catch (e) {
    const code = classify(e);
    return toErrorEnvelope(code, CURATED_MESSAGE[code]);
  }
}
