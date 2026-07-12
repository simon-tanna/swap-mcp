import type { Context } from "hono";

import type { AuthProps } from "../../auth/guards";
import { assertAudience, requireScope } from "../../auth/guards";
import { errorResponse } from "../middleware/props";

/**
 * REST parallel of `src/mcp/tools/guarded.ts`. Runs the same fail-closed gate
 * ordering as the MCP path (Major 4: audience is enforced on EVERY call, not
 * only at the transport) — `assertAudience(props, canonicalMcpUri)` FIRST, then
 * `requireScope(props, scope)` — before the route body. Any throw (from a gate
 * or the work) is routed through {@link errorResponse} for a uniform HTTP status
 * and curated, non-leaking body, so no route can forget a gate.
 */
export function guardedRoute(
  c: Context<{ Variables: { props: AuthProps } }>,
  opts: { scope: "swap:read" | "swap:write"; canonicalMcpUri: string },
  work: (props: AuthProps) => Promise<Response>,
): Promise<Response> {
  const run = async (): Promise<Response> => {
    const props = c.get("props");
    assertAudience(props, opts.canonicalMcpUri);
    requireScope(props, opts.scope);
    return work(props);
  };
  return run().catch((err: unknown) => errorResponse(c, err));
}
