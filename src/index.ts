import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import { buildDefaultApiDeps, createApiApp } from "./api/apiApp";
import { SwapCoordinator } from "./coordinator/SwapCoordinator";
import { SwapMcpAgent } from "./mcp/SwapMcpAgent";
import { publicApp } from "./oauth/publicApp";
import { RateLimiter } from "./ratelimit/RateLimiter";

/**
 * Thin per-request adapter for the REST surface. The OAuthProvider guards this
 * handler and invokes it with `(request, env, ctx)`, having already validated
 * the bearer token and placed the decoded grant props on `ctx.props`. We build
 * a FRESH `createApiApp` from `buildDefaultApiDeps(env)` on each request because
 * the API deps (D1 drizzle handle, trading-API client, coordinator stub) are
 * derived from `env`, which is only available at call time — never at module
 * scope. `propsAdapter` inside the app reads identity from `ctx.props`.
 */
const apiApp = {
  fetch(
    request: Request,
    env: CloudflareBindings,
    ctx: ExecutionContext,
  ): Response | Promise<Response> {
    return createApiApp(buildDefaultApiDeps(env)).fetch(request, env, ctx);
  },
};

/**
 * The Worker entry point: an `OAuthProvider` that owns discovery
 * (`/.well-known/*`), token issuance (`/token`), and open DCR (`/register`),
 * guards the two protected surfaces with a bearer token, and delegates every
 * public request (consent + `/healthz`) to `publicApp`.
 *
 * - `/mcp` is served by `SwapMcpAgent.serve("/mcp", { binding: "SwapMcpAgent" })`.
 *   Per M8 the default assumption is no binding arg, but the installed
 *   `agents@0.17` `serve(path, options?)` defaults `binding` to `"MCP_OBJECT"` —
 *   a name we do not declare — and looks the Durable Object up by that binding
 *   name at request time (not by class name). So the binding MUST be named
 *   explicitly to match our `SwapMcpAgent` DO binding, or the transport throws
 *   "Could not find McpAgent binding for MCP_OBJECT".
 * - Token storage uses the provider's `env.OAUTH_KV` convention (0.8.x has no
 *   `kv` option).
 * - The canonical resource (`CANONICAL_MCP_URI`) is ORIGIN-ONLY
 *   (`https://…workers.dev`, no `/mcp` path) so one operator token authorizes
 *   BOTH `/mcp` and `/api/*`: the provider's bearer `audienceMatches` accepts any
 *   path under an origin-only ("/") audience, whereas a path-scoped `.../mcp`
 *   audience would 401 every `/api/*` request. We do NOT set `resourceMetadata`:
 *   the provider auto-derives `GET /.well-known/oauth-protected-resource`'s
 *   `resource` from the request origin (verified: `https://…workers.dev`), so a
 *   real MCP client (Claude connector) reads that doc and sends a matching
 *   origin `resource`, which the consent flow accepts and the audience gate honors.
 */
export default new OAuthProvider({
  apiHandlers: {
    "/mcp": SwapMcpAgent.serve("/mcp", { binding: "SwapMcpAgent" }),
    "/api": apiApp,
  },
  defaultHandler: publicApp,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["swap:read", "swap:write"],
});

export { SwapMcpAgent, SwapCoordinator, RateLimiter };
