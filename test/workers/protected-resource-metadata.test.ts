/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

/**
 * The `/mcp` 401 challenge points MCP clients at the PATH-SCOPED protected-resource
 * metadata (`/.well-known/oauth-protected-resource/mcp`). Left to auto-derive, that
 * document advertises `<origin>/mcp` — which a spec-compliant client (Claude
 * connector) then sends as its `resource`, tripping the consent gate
 * (`Invalid resource`) and poisoning the `/api/*` token audience. `src/index.ts`
 * pins `resourceMetadata.resource` to the origin so BOTH the root and the
 * `/mcp`-scoped documents advertise the origin.
 *
 * This is ALSO the drift guard for the two independent sources of that origin
 * string: `CANONICAL_MCP_ORIGIN` (a module-scope literal in `src/index.ts`, since
 * `OAuthProvider` is constructed before `env` exists) and `CANONICAL_MCP_URI`
 * (`wrangler.jsonc`). We assert the SERVED resource (which reflects the literal)
 * EQUALS `env.CANONICAL_MCP_URI` (the var) — a failing test is the only signal if
 * the two ever diverge (e.g. after a worker rename to a new origin).
 */
describe("protected-resource metadata advertises the origin resource", () => {
  const paths = [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ];

  for (const path of paths) {
    test(`${path} advertises resource === CANONICAL_MCP_URI (not a /mcp-scoped resource)`, async () => {
      const res = await SELF.fetch(`https://worker${path}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { resource?: string };
      // Equality against the env var is the drift guard — not merely "origin-shaped".
      expect(body.resource).toBe(env.CANONICAL_MCP_URI);
      // The regression this fix closes: the path-scoped doc must NOT re-introduce
      // a `/mcp`-suffixed resource that the consent gate would reject.
      expect(body.resource).not.toContain("/mcp");
    });
  }
});
