# Stage 2 pre-planning research — package API verification (2026-07-12)

Verified via context7 + cloudflare-docs MCP + `npm view`. Feeds the domain TDD plan.

## Verified versions & pins

```json
{
  "dependencies": {
    "agents": "^0.17.3",
    "@cloudflare/workers-oauth-provider": "^0.8.1",
    "hono": "(scaffold's existing)",
    "viem": "^2.55.0",
    "drizzle-orm": "^0.45.2",
    "zod": "^4.x"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.18.4",
    "vitest": "^4.1.10",
    "drizzle-kit": "^0.31.10",
    "wrangler": "(scaffold's existing)"
  }
}
```

## Findings by package

### agents 0.17.3 (McpAgent)
- `MyMCP.serve(path, options?)` confirmed: static, returns ExportedHandler-shaped value; valid `OAuthProvider` `apiHandlers` entry. Spec's `SwapMcpAgent.serve("/mcp")` is correct.
- `options.binding` (for DO binding name ≠ class name) is likely-supported but NOT textually confirmed in current docs — **implementation-time check: verify against `node_modules/agents/dist/mcp.d.ts` after install** (already flagged in spec; keep as a task step).

### @cloudflare/vitest-pool-workers 0.18.4
- Peer dep **vitest ^4.1.0** confirmed (spec's ^4.1 / ^0.18 pairing is right).
- **`defineWorkersConfig`/`defineWorkersProject` are REMOVED.** Current style: `cloudflareTest()` Vite plugin from the package root, inside plain `defineConfig()` from `vitest/config`; options (e.g. `wrangler.configPath`, `miniflare.bindings`) passed straight to `cloudflareTest()` — no `poolOptions.workers` nesting.
- **`isolatedStorage`/`singleWorker` options are REMOVED.** Per-test-file storage isolation is the default (matches spec's per-file isolation requirement with zero config). Shared storage across files would need `--max-workers=1 --no-isolate` CLI flags — not needed for this project.
- D1 migrations in tests: `readD1Migrations(path)` inside the `cloudflareTest(async () => …)` factory → passed as a `miniflare.bindings.TEST_MIGRATIONS` binding → a `setupFiles` script calls `applyD1Migrations(env.DB, TEST_MIGRATIONS)` (imported from `cloudflare:test`). Signature `applyD1Migrations(db, migrations, migrationTableName?)` confirmed.
- **`SELF` and `fetchMock` from `cloudflare:test` are deprecated/removed** in this generation. Integration-style fetches use `import { env, exports } from "cloudflare:workers"` then `exports.default.fetch()`. Outbound-fetch mocking: mock `globalThis.fetch` directly (or MSW). The plan must use this pattern, not `SELF.fetch()`.

### @cloudflare/workers-oauth-provider 0.8.1
- Constructor option names confirmed exactly as spec assumes: `apiHandlers`, `defaultHandler`, `authorizeEndpoint`, `tokenEndpoint`, `clientRegistrationEndpoint` (+ TTLs, `scopesSupported`, `disallowPublicClientRegistration`, `onError`, etc.).
- **No `kv` constructor option.** The library reads `env.OAUTH_KV` by binding-name convention — wrangler.jsonc must bind the KV namespace as exactly `OAUTH_KV` (spec already names it OAUTH_KV; the convention is load-bearing, not stylistic).

### viem 2.55.0
- `privateKeyToAccount` (from `viem/accounts`), `createWalletClient`/`createPublicClient`, and `waitForTransactionReceipt({ hash, timeout })` (timeout in ms, default 180000) all confirmed current. No discrepancy.

### drizzle-orm 0.45.2 / drizzle-kit 0.31.10
- `defineConfig({ dialect: 'sqlite', driver: 'd1-http', dbCredentials: { accountId, databaseId, token } })` confirmed current for remote push/studio.
- Local/CI migration path is file-based: drizzle-kit `generate` emits .sql into `out`; applied via `wrangler d1 migrations apply` (and `readD1Migrations`+`applyD1Migrations` in tests). `driver: 'd1-http'` only matters for remote operations with real credentials (placeholders here).

## Planning implications (deltas the plan MUST encode)
1. vitest config task uses `cloudflareTest()` plugin style — never `defineWorkersConfig`, never `isolatedStorage`/`poolOptions.workers`.
2. Worker-fetch tests use `exports.default.fetch()` from `cloudflare:workers` — never `SELF`; outbound Trading-API fetch mocking via injected fake clients (spec) and/or `globalThis.fetch` stubs at the edges.
3. wrangler.jsonc must name the OAuth KV binding exactly `OAUTH_KV`.
4. Keep the `agents` `.serve` `{binding}` overload check as an explicit install-time step in the first scaffolding task.
