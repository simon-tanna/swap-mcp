# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Workers application (Hono + Wrangler) that exposes a crypto **swap** service over two authenticated surfaces:

- **`/mcp`** — a Model Context Protocol server (`SwapMcpAgent`, built on the `agents` SDK) with tools: `getQuote`, `executeSwap`, `getTransaction`, `listTransactions`.
- **`/api/*`** — a REST mirror of the same capabilities (`quote`, `swap`, `transactions`).

Both surfaces are guarded by `@cloudflare/workers-oauth-provider`, share one operator token, and delegate execution to a `SwapCoordinator` Durable Object that signs and submits Ethereum transactions via `viem` against the Uniswap Trading API. State lives in **D1** (Drizzle ORM); rate limiting and swap coordination are **Durable Objects**.

## Commands

Uses **pnpm** (pinned via `packageManager` in `package.json`). Do not use npm or yarn — it would create a competing lockfile.

```bash
pnpm install
pnpm dev          # Local dev server via `wrangler dev`
pnpm test         # Run all vitest projects (node + workers + integration)
pnpm typecheck    # tsc --noEmit
pnpm lint         # prettier --check .
pnpm format       # prettier --write .
pnpm db:generate  # Generate a Drizzle migration into ./drizzle
pnpm smoke        # Run scripts/smoke.ts
pnpm cf-typegen   # Regenerate CloudflareBindings from wrangler.jsonc
pnpm deploy       # Deploy with `wrangler deploy --minify`
```

## Architecture

- **Entry point** `src/index.ts` exports a single `new OAuthProvider({...})`. It owns discovery (`/.well-known/*`), token issuance (`/token`), and open DCR (`/register`); routes `/mcp` and `/api` to bearer-guarded handlers; and sends everything else (consent UI + `/healthz`) to `oauth/publicApp`.
- **`/mcp`** is served by `SwapMcpAgent.serve("/mcp", { binding: "SwapMcpAgent" })`, fronted by `transportGuard` (Origin allowlist + required `MCP-Protocol-Version` header) before the transport is reached.
- **`/api/*`** builds a **fresh** `createApiApp(buildDefaultApiDeps(env))` on every request — deps (D1 handle, trading-API client, coordinator stub) derive from `env`, which only exists at call time, never at module scope.
- **Durable Objects:** `SwapCoordinator` (`src/coordinator`, signs/submits swaps and owns the transaction lifecycle), `SwapMcpAgent` (`src/mcp`, MCP session state), and `RateLimiter` (`src/ratelimit`) — all SQLite-backed.
- **Layers:** `src/services` (swapService, rails) → `src/engine` (tradingApiClient, viemSigner) and `src/repository` + `src/db/schema.ts` (Drizzle/D1). Errors are funneled through `src/errors.ts` into curated, non-leaking `{ error: { code, message } }` bodies.

## Testing

`vitest.config.ts` defines three projects:

- **node** (`test/node/**`) — plain Node environment, pure-logic units.
- **workers** (`test/workers/**`) — `@cloudflare/vitest-pool-workers` (Miniflare) with real bindings; DOs, routes, MCP harness.
- **integration** (`test/integration/**`) — same pool, OAuth end-to-end flows.

The two pool projects apply D1 migrations via `test/setup/apply-migrations.ts` and inject fake secrets (well-known Anvil key, etc.) through Miniflare `bindings`.

## Gotchas

- **DO binding names are load-bearing.** `SwapMcpAgent`'s binding name must equal its class name (McpAgent resolves the DO by class name at request time) — do _not_ rename it to SCREAMING_SNAKE. `agents@0.17` `serve()` defaults `binding` to `"MCP_OBJECT"`, which we don't declare, so it must be passed explicitly.
- **`CANONICAL_MCP_URI` is origin-only** (no `/mcp` path) so one operator token authorizes both `/mcp` and `/api/*`. A path-scoped audience would 401 every `/api/*` request (the provider's `handleApiRequest` audience check only treats an origin-only, `"/"`-path audience as covering all paths).
- **The origin resource is _advertised_, not just auto-derived.** In provider 0.8.x the protected-resource metadata is path-scoped: the `/mcp` 401 points clients at `/.well-known/oauth-protected-resource/mcp`, which auto-derives `resource = <origin>/mcp`. So `src/index.ts` sets `resourceMetadata.resource` to the origin, overriding the derivation for the root AND `/mcp`-scoped docs; without it, Claude sends `resource=<origin>/mcp` and the consent gate returns `Invalid resource`. That literal (`CANONICAL_MCP_ORIGIN`) must stay in sync with `CANONICAL_MCP_URI` — a drift-guard test enforces it. `resourceMatchOriginOnly` stays default-`false` (orthogonal — it only affects the requested-vs-granted check at token exchange).

## Conventions

- ESM only (`"type": "module"`), `strict` TypeScript, `ESNext` + bundler resolution. `nodejs_compat` is enabled.
- After changing `wrangler.jsonc` bindings, run `pnpm cf-typegen` and thread `CloudflareBindings` through Hono as `new Hono<{ Bindings: CloudflareBindings }>()`.
- `compatibility_date` pins runtime behavior — bump deliberately.
- Secrets are declared by name under `secrets.required` in `wrangler.jsonc` and set via `wrangler secret put`; `validateEnv` fails closed if any are missing. Never read or log secret values.
