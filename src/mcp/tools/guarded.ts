import { assertAudience, requireScope } from "../../auth/guards";
import {
  classify,
  toErrorEnvelope,
  CURATED_MESSAGE,
  type ErrorEnvelope,
} from "../../errors";
import type { ToolDeps } from "./deps";

/** A successful tool result: human-readable text plus machine-readable structure. */
export type ToolSuccess = {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
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
