# swap-mcp Implementation Plan (domain: general-purpose — all components)

**Issue:** mcp-migration-plan (spec v3.1, `.agentic-loop/mcp-migration-plan/spec.md`)
**Branch:** feat/mcp-migration-plan
**Goal:** Build the full swap-mcp service (OAuth-guarded MCP + REST surfaces over a SwapCoordinator DO, D1 lifecycle tracking, mocked-chain Uniswap Trading API + viem engine) into the fresh Hono/Workers scaffold, strictly test-first.
**Architecture:** Worker default export is `OAuthProvider` guarding `/mcp` (`SwapMcpAgent` McpAgent DO) and `/api` (Hono REST app); both delegate to a pure `services/` layer and the `SwapCoordinator` DO, which serializes execution and eagerly writes lifecycle state to D1 via Drizzle. Passphrase consent is CSRF-protected and rate-limited by a strongly-consistent `RateLimiter` DO. The chain sits behind two injectable seams (`TradingApiClient`, `ViemSigner`) and is fully mocked in all automated tests.
**Tech stack:** hono (existing), `agents@^0.17.3`, `@modelcontextprotocol/sdk`, `@cloudflare/workers-oauth-provider@^0.8.1`, `zod@^4`, `drizzle-orm@^0.45.2`, `viem@^2.55.0`; dev: `wrangler` (existing), `vitest@^4.1.10`, `@cloudflare/vitest-pool-workers@^0.18.4`, `drizzle-kit@^0.31.10`, `tsx`, `prettier`.

**Global commit constraint (applies to every task; not repeated per task):** commit messages are conventional-commit style; every body includes a `TDD:` line referencing the test file written before the implementation; **no `Co-Authored-By:` or any AI-attribution trailer on any commit** (spec §8, decision 13).

**Global test-gate constraint:** the repo's resolved quality gate is `pnpm typecheck && pnpm vitest run` (there is no `scripts/quality-gates.sh` in this repo). Every task must end with this gate green. "Run full gate" in task steps means exactly this command pair.

**Global mocking constraint (spec §6, decision 8):** no automated test may hit the network or a real RPC. Chain I/O is exercised only through injected fake `TradingApiClient` / `ViemSigner` implementations returning recorded fixtures from `test/fixtures/`. `scripts/smoke.ts` (T34) is the only real-chain artifact and is never run by the suite.

**Vitest layout (research-stage2 — overrides any older API memory):** `vitest.config.ts` uses the `cloudflareTest()` Vite plugin from `@cloudflare/vitest-pool-workers` inside plain `defineConfig` from `vitest/config` — never `defineWorkersConfig`, never `poolOptions.workers`, never `isolatedStorage`/`singleWorker` (per-file isolation is the default). Worker-level fetches in tests use `import { env, exports } from "cloudflare:workers"` and `exports.default.fetch()` — never `SELF`. DO instance access uses `runInDurableObject` from `cloudflare:test` (confirmed current). D1 migrations reach tests via `readD1Migrations("./drizzle")` → `miniflare.bindings.TEST_MIGRATIONS` → `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` in a setup file.

---

## File Structure

Test tree: `test/node/**` (node pool), `test/workers/**` (workers pool), `test/integration/**` (workers pool, full-worker fetch), `test/fixtures/**` (recorded Trading API / receipt fixtures), `test/helpers/**` (fake clients, token-mint helper).

- Modify `package.json` — deps, devDeps, scripts (`test`, `typecheck`, `lint`, `format`, `db:generate`, `smoke`)
- Modify `wrangler.jsonc` — `nodejs_compat`, vars, `OAUTH_KV`, `DB` (D1), three DO bindings + `new_sqlite_classes` (built up across T2/T18/T24/T28)
- Create `vitest.config.ts` — three projects: node / workers / integration
- Create `test/setup/apply-migrations.ts` — `applyD1Migrations` setup file
- Create `src/errors.ts` — closed `ErrorCode` allowlist, `AppError`, `classify`, `toErrorEnvelope`
- Create `src/log.ts` — `redact` + structured `log`
- Create `src/env.ts` — `validateEnv`, secret accessor functions, host allowlist
- Create `src/auth/constantTime.ts` — SHA-256-then-constant-time compare
- Create `src/auth/guards.ts` — `transportGuard`, `assertAudience`, `requireScope`, `AuthProps`, `SINGLE_USER_ID`
- Create `src/db/schema.ts` — `swaps` table (Drizzle)
- Create `drizzle.config.ts` + `drizzle/*` — drizzle-kit config + generated SQL migrations
- Create `src/engine/constants.ts` — mainnet address constants + native-ETH sentinel
- Create `src/repository/cursor.ts` — opaque strictly-schema-validated `(createdAt, id)` cursor codec
- Create `src/repository/transactions.ts` — Drizzle repository incl. cursor pagination
- Create `src/services/rails.ts` — pure safety rails, drift math, slippage percent↔fraction
- Create `src/engine/tradingApiClient.ts` — `TradingApiClient` interface + fetch-backed factory, routing-shape assertion, timeout/retry policy
- Create `src/engine/viemSigner.ts` — `ViemSigner` interface + viem-backed factory, direction-aware balances, receipt disambiguation
- Create `src/services/swapService.ts` — `getQuote` / `executeSwap` orchestration behind deps
- Create `src/coordinator/SwapCoordinator.ts` — DO: promise-chain mutex + lifecycle writes
- Create `src/mcp/tools/getQuote.ts`, `src/mcp/tools/getTransaction.ts`, `src/mcp/tools/listTransactions.ts`, `src/mcp/tools/executeSwap.ts` — per-tool registrars
- Create `src/mcp/SwapMcpAgent.ts` — McpAgent wiring the registrars
- Create `src/api/middleware/props.ts` — props-adapter middleware + `errorCodeToHttpStatus`
- Create `src/api/apiApp.ts` + `src/api/routes/*` — REST mirror routes
- Create `src/oauth/publicApp.ts` — `/healthz`, `GET/POST /authorize`
- Create `src/oauth/csrf.ts` — single-use OAUTH_KV-nonce CSRF token bound to the AuthRequest
- Create `src/ratelimit/RateLimiter.ts` — strongly-consistent rate-limit DO
- Modify `src/index.ts` — default export `new OAuthProvider(...)`, re-export DO classes
- Create `docs/tutorials/getting-started.md`, `docs/how-to/configure-secrets-and-deploy.md`, `docs/how-to/one-time-usdc-approval.md`, `docs/how-to/reconcile-stranded-submitted.md`, `docs/reference/api-and-data-model.md`, `docs/explanation/architecture-decisions.md`
- Create `scripts/smoke.ts` — manual real-chain smoke script (tsx)
- Test files: named per task below.

---

### Task 1: Dependencies, package scripts, node-pool vitest project

**Domain:** general-purpose
**Files:**

- Modify: `package.json`
- Create: `vitest.config.ts` (node project only at this point)
- Test: `test/node/canary.test.ts`

**Test contract:**

- File: `test/node/canary.test.ts`
- Test name: `node test pool boots and runs a trivial assertion`
- Assertions:
  - `expect(1 + 1).toBe(2)` executes green under `pnpm vitest run` (scaffolding — proves the vitest 4 + node project config boots)

**Expected first-run failure:** `pnpm vitest run` fails before the test file exists with "No test files found" (or the config file import fails) — proving the gate is real before the canary lands.

**Implementation surface:**

- `package.json` dependencies: `agents@^0.17.3`, `@modelcontextprotocol/sdk`, `@cloudflare/workers-oauth-provider@^0.8.1`, `zod@^4`, `drizzle-orm@^0.45.2`, `viem@^2.55.0` (keep existing `hono`)
- `package.json` devDependencies: `@cloudflare/vitest-pool-workers@^0.18.4` (pin whatever patch exports `cloudflareTest()` with the vitest ^4.1 peer at install time), `vitest@^4.1.10`, `drizzle-kit@^0.31.10`, `tsx`, `prettier` (keep existing `wrangler`)
- `package.json` scripts: `test: "vitest run"`, `typecheck: "tsc --noEmit"`, `lint: "prettier --check ."`, `format: "prettier --write ."`, `db:generate: "drizzle-kit generate"`, `smoke: "tsx scripts/smoke.ts"` (existing `dev`/`deploy`/`cf-typegen` unchanged; pnpm only)
- `vitest.config.ts`: `defineConfig` from `vitest/config` with `test.projects` containing one project `{ test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node" } }`

**Expected pass criteria:** `pnpm install` succeeds with a single pnpm lockfile; canary green; `pnpm typecheck` exits 0.

- [ ] **Step 1:** Run `pnpm vitest run` before adding anything — confirm it fails (no config/tests).
- [ ] **Step 2:** Add deps/devDeps/scripts to `package.json`; `pnpm install`.
- [ ] **Step 3 (install-time verification, research-stage2 §Planning implications #4):** Inspect `node_modules/agents/dist/mcp.d.ts` and confirm the static `serve(path, options?)` overload exists and note whether `options.binding` is present. Record the finding as a code comment where `SwapMcpAgent.serve("/mcp")` will be called (T31). The plan assumes the no-`{ binding }` form (spec §5.6/M8).
- [ ] **Step 4:** Create `vitest.config.ts` (node project) and `test/node/canary.test.ts`; run `pnpm vitest run`, confirm green.
- [ ] **Step 5:** Run full gate (`pnpm typecheck && pnpm vitest run`).
- [ ] **Step 6:** Commit. Message: `chore(deps): install runtime and test toolchain with node vitest project`. Body: `TDD: test/node/canary.test.ts written before config finalization; gate proven red then green.`

---

### Task 2: wrangler.jsonc base bindings + workers-pool vitest project

**Domain:** general-purpose
**Files:**

- Modify: `wrangler.jsonc`
- Modify: `vitest.config.ts`
- Test: `test/workers/canary.test.ts`

**Test contract:**

- File: `test/workers/canary.test.ts`
- Test name: `workers pool boots with wrangler config and exposes bindings`
- Assertions:
  - `env.OAUTH_KV` is defined (covers G12 placeholder-bindings; scaffolding for G1/G2 — the `OAUTH_KV` name is load-bearing: `@cloudflare/workers-oauth-provider@0.8.1` reads `env.OAUTH_KV` by convention, there is no `kv` constructor option)
  - `env.DB` is defined and `env.DB.prepare("SELECT 1").first()` resolves (covers G12; scaffolding for G8)
  - `env.CHAIN_ID === "1"`, `env.CANONICAL_MCP_URI`, `env.TRADING_API_BASE_URL`, `env.ALLOWED_ORIGINS` are defined (covers G12)

**Expected first-run failure:** `env.OAUTH_KV is undefined` (bindings not yet declared in `wrangler.jsonc`).

**Implementation surface:**

- `wrangler.jsonc`: uncomment/set `compatibility_flags: ["nodejs_compat"]` (explicitly uncommented — G12); `vars: { CHAIN_ID: "1", CANONICAL_MCP_URI: "https://swap-mcp.example.workers.dev/mcp", TRADING_API_BASE_URL: "https://trade-api.gateway.uniswap.org/v1", ALLOWED_ORIGINS: "https://claude.ai,https://swap-mcp.example.workers.dev" }` (placeholder host values); `kv_namespaces: [{ binding: "OAUTH_KV", id: "<placeholder-kv-id>" }]`; `d1_databases: [{ binding: "DB", database_name: "swap-mcp", database_id: "<placeholder-d1-id>", migrations_dir: "drizzle" }]`. Secrets (`SWAP_PRIVATE_KEY`, `AUTH_PASSPHRASE`, `UNISWAP_API_KEY`, `ETH_RPC_URL`) documented in a JSONC comment as `wrangler secret put` placeholders, never committed. DO bindings and the `migrations` block are added incrementally by T18/T24/T28 as each DO class comes into existence (the wrangler config must never name a class the worker does not export, or the pool fails to boot); final state matches spec §5.1 exactly.
- `vitest.config.ts`: add second project `{ plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })], test: { name: "workers", include: ["test/workers/**/*.test.ts"] } }` — plugin style only (no `defineWorkersConfig`).

**Expected pass criteria:** both canaries green; `pnpm cf-typegen` succeeds and regenerates `CloudflareBindings` containing `OAUTH_KV`, `DB`, and the vars (G12 AC).

- [ ] **Step 1:** Write `test/workers/canary.test.ts` with the assertions above; add the workers project to `vitest.config.ts`; run — confirm failure on missing bindings.
- [ ] **Step 2:** Edit `wrangler.jsonc` as specified (verify the KV binding is spelled exactly `OAUTH_KV`).
- [ ] **Step 3:** Run `pnpm cf-typegen`; confirm `CloudflareBindings` includes the new bindings.
- [ ] **Step 4:** Run tests, confirm green. Run full gate.
- [ ] **Step 5:** Commit. Message: `chore(config): declare placeholder bindings and workers test pool`. Body: `TDD: test/workers/canary.test.ts written before wrangler.jsonc changes.`

---

### Task 3: Errors — closed ErrorCode allowlist, classify, envelope

**Domain:** general-purpose
**Files:**

- Create: `src/errors.ts`
- Test: `test/node/errors.test.ts`

**Test contract:**

- File: `test/node/errors.test.ts`
- Test names: `ErrorCode allowlist is closed and exact`, `classify maps AppError and unknown errors`, `toErrorEnvelope produces the MCP envelope shape`
- Assertions:
  - The exported `ERROR_CODES` tuple equals exactly `["invalid_input","unauthorized","forbidden","not_found","slippage_exceeded","insufficient_balance","approval_required","upstream_unavailable","rate_limited","swap_failed","internal"]` — `quote_expired` absent, `approval_required` present (covers §7 G10)
  - `classify(new AppError("slippage_exceeded"))` returns `"slippage_exceeded"`; `classify(new Error("boom"))` and `classify("junk")` return `"internal"` (covers G10)
  - `toErrorEnvelope("invalid_input", "bad amount")` returns `{ content: [{ type: "text", text: <string> }], structuredContent: { error: { code: "invalid_input", message: "bad amount" } }, isError: true }` (covers G10)
  - the envelope `message` never contains the raw `.message` of a classified internal error — `toErrorEnvelope(classify(new Error("secret-detail")), CURATED[code])` contains no `"secret-detail"` (covers §7 G10: raw upstream/internal messages never reflected)

**Expected first-run failure:** `Cannot find module '../../src/errors'` / `AppError is not a constructor`.

**Implementation surface:**

- `export const ERROR_CODES = [...] as const; export type ErrorCode = (typeof ERROR_CODES)[number]`
- `export class AppError extends Error { readonly code: ErrorCode; constructor(code: ErrorCode, publicMessage?: string) }`
- `export function classify(err: unknown): ErrorCode`
- `export function toErrorEnvelope(code: ErrorCode, publicMessage: string): ErrorEnvelope` (type exported)

**Expected pass criteria:** all assertions green; gate green.

- [ ] **Step 1:** Write failing test. **Step 2:** Confirm module-not-found failure. **Step 3:** Implement `src/errors.ts` minimally. **Step 4:** Green. **Step 5:** Full gate. **Step 6:** Commit: `feat(errors): closed ErrorCode allowlist with classify and envelope`. Body: `TDD: test/node/errors.test.ts written before src/errors.ts.`

---

### Task 4: Logger redaction + enforced envelope redaction

**Domain:** general-purpose
**Files:**

- Create: `src/log.ts`
- Modify: `src/errors.ts` (route `toErrorEnvelope` message through `redact`)
- Test: `test/node/log.test.ts`

**Test contract:**

- File: `test/node/log.test.ts`
- Test names: `redact scrubs secret-name keys`, `redact truncates long hex runs`, `log emits structured JSON through redact unconditionally`, `toErrorEnvelope runs the same redaction pass`
- Assertions:
  - `redact({ privateKey: "0xabc...", passphrase: "p", apiKey: "k", authorization: "Bearer x", rpcUrl: "https://r" })` replaces every value with `"[redacted]"` (covers §7 G10 leak test)
  - `redact({ note: "0x" + "ab".repeat(40) })` redacts/truncates the >42-char hex run, while a 42-char address value survives intact (covers §7 G10)
  - a spy on `console.log` shows `log("info", { privateKey: "x" })` serialized JSON containing `"[redacted]"` and never `"x"` — redaction is applied inside `log`, not by caller convention (covers G10)
  - `toErrorEnvelope("internal", "leak 0x" + "ab".repeat(40)).structuredContent.error.message` contains no long hex (covers §7 G10: envelope redaction enforced)

**Expected first-run failure:** `Cannot find module '../../src/log'`.

**Implementation surface:**

- `export function redact(fields: Record<string, unknown>): Record<string, unknown>` (recursive; secret-name key patterns + long-hex scrubber)
- `export function log(level: "info" | "warn" | "error", fields: Record<string, unknown>): void`
- `src/errors.ts`: `toErrorEnvelope` passes `publicMessage` through the long-hex/secret scrub from `redact` before embedding

**Expected pass criteria:** all four tests green; T3 tests still green; gate green.

- [ ] Steps 1–6 per red-green template. Commit: `feat(log): structured logger with enforced redaction shared by error envelopes`. Body: `TDD: test/node/log.test.ts written before src/log.ts.`

---

### Task 5: Env validation — fail-closed, host allowlist, secret accessors

**Domain:** general-purpose
**Files:**

- Create: `src/env.ts`
- Test: `test/node/env.test.ts`

**Test contract:**

- File: `test/node/env.test.ts`
- Test names: `validateEnv fails closed on any missing secret or var`, `CHAIN_ID must be "1"`, `TRADING_API_BASE_URL host allowlist`, `secrets are accessor functions, never plain fields`
- Assertions:
  - a complete fake env validates; removing any one of `SWAP_PRIVATE_KEY`, `AUTH_PASSPHRASE`, `UNISWAP_API_KEY`, `ETH_RPC_URL`, `CHAIN_ID`, `CANONICAL_MCP_URI`, `TRADING_API_BASE_URL`, `ALLOWED_ORIGINS` makes `validateEnv` throw (covers §7 G12 fail-closed; the throw is classified `internal` by T3's `classify` — asserted)
  - `CHAIN_ID: "5"` throws (covers G12/non-goal single-chain)
  - `TRADING_API_BASE_URL: "https://evil.example/v1"` throws; `"https://trade-api.gateway.uniswap.org/v1"` passes (covers §5.2 host allowlist — G12/G10)
  - `JSON.stringify(validatedEnv)` and `Object.values(validatedEnv)` contain none of the four secret values; `validatedEnv.getSwapPrivateKey()` returns the secret lazily (covers §7 G10/G12 secret-accessor shape)
  - `validatedEnv.allowedOrigins` is the parsed array from the comma-separated `ALLOWED_ORIGINS` var (scaffolding for §5.6 Origin allowlist)

**Expected first-run failure:** `Cannot find module '../../src/env'`.

**Implementation surface:**

- `export interface ValidatedEnv { chainId: "1"; canonicalMcpUri: string; tradingApiBaseUrl: string; allowedOrigins: string[]; getSwapPrivateKey(): string; getAuthPassphrase(): string; getUniswapApiKey(): string; getEthRpcUrl(): string }`
- `export function validateEnv(env: CloudflareBindings): ValidatedEnv` (Zod v4 schema; throws `AppError("internal", ...)` on failure; secrets captured only inside accessor closures)

**Expected pass criteria:** all green; gate green.

- [ ] Steps 1–6 per template. Commit: `feat(env): fail-closed Zod env validation with secret accessors and host allowlist`. Body: `TDD: test/node/env.test.ts written before src/env.ts.`

---

### Task 6: Constant-time passphrase compare (M10)

**Domain:** general-purpose
**Files:**

- Create: `src/auth/constantTime.ts`
- Test: `test/node/constant-time.test.ts`

**Test contract:**

- File: `test/node/constant-time.test.ts`
- Test names: `equal strings compare true`, `unequal strings compare false`, `length difference compares false without throwing`, `comparison operates on SHA-256 digests`
- Assertions:
  - `await timingSafeEqualDigest("secret", "secret")` is `true` (covers §7 G2 SHA-256-then-constant-time)
  - `await timingSafeEqualDigest("secret", "secreT")` and `("secret", "sec")` are `false`, no throw (covers G2 — digesting normalizes length)
  - the implementation digests both inputs with SHA-256 before comparing: assert via an injected/spied `digest` seam (e.g. `timingSafeEqualDigest(a, b, { digest })` records two SHA-256 calls) (covers §7 G2)

**Expected first-run failure:** `Cannot find module '../../src/auth/constantTime'`.

**Implementation surface:**

- `export async function timingSafeEqualDigest(a: string, b: string, deps?: { digest?: (data: Uint8Array) => Promise<ArrayBuffer> }): Promise<boolean>` — SHA-256 both sides via `crypto.subtle.digest`, then constant-time byte compare of the two 32-byte digests (never a raw string compare)

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(auth): SHA-256 digest constant-time passphrase compare`. Body: `TDD: test/node/constant-time.test.ts written before src/auth/constantTime.ts.`

---

### Task 7: Auth guards — transport, audience, scope

**Domain:** general-purpose
**Files:**

- Create: `src/auth/guards.ts`
- Test: `test/node/guards.test.ts`

**Test contract:**

- File: `test/node/guards.test.ts`
- Test names: `transportGuard enforces Origin allowlist and MCP-Protocol-Version`, `assertAudience fails closed on foreign resource`, `requireScope gates read and write`, `SINGLE_USER_ID is a stable constant`
- Assertions:
  - `transportGuard(reqWithOrigin("https://claude.ai") + MCP-Protocol-Version header, allowedOrigins)` passes; a disallowed Origin throws `AppError("forbidden")`; a missing `MCP-Protocol-Version` header throws `AppError("invalid_input")` (covers §5.5(a) — G1/G2/G10)
  - `assertAudience({ resource: "https://other/mcp" }, canonicalUri)` throws `AppError("forbidden")`; matching resource passes (covers §5.5(b) — G2)
  - `requireScope({ scopes: ["swap:read"] }, "swap:write")` throws `AppError("forbidden")`; `requireScope({ scopes: ["swap:read","swap:write"] }, "swap:write")` passes; missing scopes array throws (covers §7 G2 read-only-token rejection at gate level — G2/G10)
  - `SINGLE_USER_ID` is exported and non-empty (scaffolding for G2 props)

**Expected first-run failure:** `Cannot find module '../../src/auth/guards'`.

**Implementation surface:**

- `export type AuthProps = { userId: string; scopes: string[]; resource: string }`
- `export const SINGLE_USER_ID: string`
- `export function transportGuard(req: Request, allowedOrigins: string[]): void`
- `export function assertAudience(props: Pick<AuthProps, "resource">, canonicalMcpUri: string): void`
- `export function requireScope(props: Pick<AuthProps, "scopes">, scope: "swap:read" | "swap:write"): void`

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(auth): transport, audience and scope guards`. Body: `TDD: test/node/guards.test.ts written before src/auth/guards.ts.`

---

### Task 8: D1 schema, drizzle-kit migrations, test-migration wiring

**Domain:** general-purpose
**Files:**

- Create: `src/db/schema.ts`, `drizzle.config.ts`, `drizzle/*` (generated), `test/setup/apply-migrations.ts`
- Modify: `vitest.config.ts` (async `cloudflareTest` factory: `readD1Migrations("./drizzle")` → `miniflare.bindings.TEST_MIGRATIONS`; add `setupFiles: ["./test/setup/apply-migrations.ts"]` to workers project)
- Test: `test/workers/schema.test.ts`

**Test contract:**

- File: `test/workers/schema.test.ts`
- Test names: `migrations create the swaps table with all lifecycle columns`, `a full row inserts and reads back via drizzle`, `status column admits exactly the four lifecycle values`
- Assertions:
  - after setup, `PRAGMA table_info(swaps)` (via `env.DB`) lists exactly: `id, userId, direction, amountIn, expectedAmountOut, quotedAmountOut, actualAmountOut, slippageTolerancePct, deadlineSeconds, txHash, status, errorCode, gasUsed, createdAt, submittedAt, settledAt` (covers §7 G8 lifecycle columns)
  - `drizzle(env.DB, { schema })` inserts a row with `status: "pending"` and reads it back with identical values, nullable columns null (covers G8)
  - inserting `status: "timed_out"` is rejected (CHECK constraint / enum) — **no fifth status** (covers §7 G3/G8 no-fifth-status)

**Expected first-run failure:** `no such table: swaps` (migrations dir empty / schema module missing).

**Implementation surface:**

- `src/db/schema.ts`: `export const swaps = sqliteTable("swaps", ...)` per §5.11 (uuid PK `id`; `direction` in `("ETH_TO_USDC","USDC_TO_ETH")`; `status` CHECK-constrained to `("pending","submitted","confirmed","failed")`; amounts as text base-unit strings; timestamps as integer epoch-ms)
- `drizzle.config.ts`: `defineConfig({ dialect: "sqlite", schema: "./src/db/schema.ts", out: "./drizzle" })` (no `d1-http` credentials — placeholders only; local/CI path is file-based per research-stage2)
- run `pnpm db:generate` to emit `drizzle/*.sql`
- `test/setup/apply-migrations.ts`: `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` (import from `cloudflare:test`)

**Expected pass criteria:** schema tests green with per-file-isolated D1; T2 canary still green; gate green.

- [ ] **Step 1:** Write failing test. **Step 2:** Confirm `no such table` failure. **Step 3:** Implement schema + config, generate migrations, wire `TEST_MIGRATIONS` + setup file. **Step 4:** Green. **Step 5:** Full gate. **Step 6:** Commit: `feat(db): swaps schema with drizzle-kit migrations applied in tests`. Body: `TDD: test/workers/schema.test.ts written before src/db/schema.ts.`

---

### Task 9: Mainnet address constants + native sentinel

**Domain:** general-purpose
**Files:**

- Create: `src/engine/constants.ts`
- Test: `test/node/constants.test.ts`

**Test contract:**

- File: `test/node/constants.test.ts`
- Test name: `each embedded mainnet address equals its known-good checksummed value`
- Assertions (each traceable to §7 G5 address-constants clause):
  - `USDC_ADDRESS === "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"`
  - `WETH9_ADDRESS === "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"`
  - `UNIVERSAL_ROUTER_ADDRESS === "0x66a9893cc07d91d95644aedd05d03f95e1dba8af"`
  - `PERMIT2_ADDRESS === "0x000000000022D473030F116dDEE9F6B43aC78BA3"`
  - `NATIVE_ETH_SENTINEL === "0x0000000000000000000000000000000000000000"`
  - `MAINNET_CHAIN_ID === "1"` (string — the Trading API takes chain ids as strings)

**Expected first-run failure:** `Cannot find module '../../src/engine/constants'`.

**Implementation surface:** the six named exported `const`s above (literal types).

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(engine): pinned mainnet address constants with checksummed assertions`. Body: `TDD: test/node/constants.test.ts written before src/engine/constants.ts.`

---

### Task 10: Opaque cursor codec with tamper rejection

**Domain:** general-purpose
**Files:**

- Create: `src/repository/cursor.ts`
- Test: `test/node/cursor.test.ts`

**Test contract:**

- File: `test/node/cursor.test.ts`
- Test names: `cursor round-trips (createdAt, id)`, `tampered cursor is rejected with invalid_input`, `garbage cursor is rejected with invalid_input`
- Assertions:
  - `decodeCursor(encodeCursor({ createdAt: 1720000000000, id: "<uuid>" }))` returns the same payload (covers §7 G3 stable cursor)
  - flipping one character of an encoded cursor makes `decodeCursor` throw `AppError("invalid_input")` (covers §7 G3/G4 tampered-cursor rejection — spec §5.7 permits "strictly schema-validated" in place of HMAC; this codec strictly Zod-validates the base64url JSON payload `{ createdAt: positive int, id: uuid }` so any tamper producing an out-of-schema payload is rejected; structurally-valid-but-different cursors merely address a different page and leak nothing)
  - `decodeCursor("not-base64!!")` throws `AppError("invalid_input")` (covers G3/G4)

**Expected first-run failure:** `Cannot find module '../../src/repository/cursor'`.

**Implementation surface:**

- `export type CursorPayload = { createdAt: number; id: string }`
- `export function encodeCursor(p: CursorPayload): string` (base64url of canonical JSON)
- `export function decodeCursor(cursor: string): CursorPayload` (strict Zod parse; throws `AppError("invalid_input")`)

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(repository): opaque strictly-validated pagination cursor`. Body: `TDD: test/node/cursor.test.ts written before src/repository/cursor.ts.`

---

### Task 11: Transactions repository with cursor pagination

**Domain:** general-purpose
**Files:**

- Create: `src/repository/transactions.ts`
- Test: `test/workers/repository.test.ts`

**Test contract:**

- File: `test/workers/repository.test.ts`
- Test names: `insertPending creates a pending row`, `markSubmitted / markConfirmed / markFailed transition the row`, `markFailed records errorCode without txHash for pre-submit aborts`, `findById returns the live row`, `list paginates by (createdAt, id) with default 20 and cap 100`, `list rejects a tampered cursor`, `list filters by status`
- Assertions:
  - `insertPending` returns the row id; the D1 row has `status:"pending"`, `createdAt` set, null `txHash` (covers §7 G8)
  - `markSubmitted(id, txHash)` sets `status:"submitted"`, `txHash`, `submittedAt`; `markConfirmed(id, { actualAmountOut, gasUsed })` sets `status:"confirmed"`, `settledAt`; `markFailed(id, "swap_failed", { txHash })` keeps `txHash` (covers §7 G8 lifecycle)
  - `markFailed(id, "slippage_exceeded")` yields `status:"failed"`, `errorCode:"slippage_exceeded"`, `txHash` null (covers §7 G8 pre-submit abort disposition)
  - `findById` returns the current row; unknown id returns `undefined` (covers G9)
  - seeding 25 rows: `list({})` returns 20 rows ordered by `(createdAt, id)` desc + non-null `nextCursor`; passing `nextCursor` back returns the remaining 5 with `nextCursor: null`; `list({ limit: 500 })` returns ≤100 (covers §7 G3 pagination defaults/caps/stable nextCursor)
  - `list({ cursor: tampered })` throws `AppError("invalid_input")` (covers §7 G3)
  - `list({ status: "failed" })` returns only failed rows (covers §5.7 status filter — G3)

**Expected first-run failure:** `Cannot find module '../../src/repository/transactions'`.

**Implementation surface:**

- `export function createTransactionsRepository(db: DrizzleD1Database<typeof schema>): TransactionsRepository`
- `export interface TransactionsRepository { insertPending(row: NewSwapInput): Promise<string>; markSubmitted(id: string, txHash: string): Promise<void>; markConfirmed(id: string, r: { actualAmountOut: string; gasUsed: string }): Promise<void>; markFailed(id: string, errorCode: ErrorCode, opts?: { txHash?: string }): Promise<void>; findById(id: string): Promise<SwapRow | undefined>; list(q: { limit?: number; cursor?: string; status?: SwapStatus }): Promise<{ rows: SwapRow[]; nextCursor: string | null }> }`

**Expected pass criteria:** green against migrated per-file D1; gate green.

- [ ] Steps 1–6. Commit: `feat(repository): transactions repository with lifecycle transitions and cursor pagination`. Body: `TDD: test/workers/repository.test.ts written before src/repository/transactions.ts.`

---

### Task 12: Pure safety rails, drift math, slippage units

**Domain:** general-purpose
**Files:**

- Create: `src/services/rails.ts`
- Test: `test/node/rails.test.ts`

**Test contract:**

- File: `test/node/rails.test.ts`
- Test names: `slippage defaults to 0.5 and caps at 5`, `deadline defaults to 1200`, `amountIn must be a positive base-unit integer`, `pctToFraction converts percent to fraction`, `drift check — caller-supplied floor branch`, `drift check — omitted floor branch never aborts`
- Assertions:
  - `resolveSwapParams({ direction, amountIn })` yields `slippageTolerancePct: 0.5`, `deadlineSeconds: 1200`; `slippageTolerancePct: 5` accepted; `5.1` throws `AppError("invalid_input")` (covers §7 G6 cap/defaults)
  - `amountIn: "0"`, `"-1"`, `"1.5"`, `""` each throw `AppError("invalid_input")`; `"1000000"` passes (covers §7 G6 amount>0)
  - `pctToFraction(0.5) === 0.005` — percent at the API/MCP boundary, fraction in math (covers §7 G6/G5 slippage units)
  - caller-floor branch: with `expectedAmountOut = 1000n`, `tol = 0.5`, `checkDrift(994n, 1000n, 0.5)` returns `{ abort: true }` (994 < 1000 × 0.995) and `checkDrift(996n, 1000n, 0.5)` returns `{ abort: false }` (covers §7 G3/G6 drift floor)
  - omitted-floor branch: `checkDrift(anyFresh, undefined, tol)` always returns `{ abort: false }` — no drift abort; the API-embedded slippage floor is the only rail (covers §7 G3/G6 omitted-floor semantics; guards the v2 double-count bug)

**Expected first-run failure:** `Cannot find module '../../src/services/rails'`.

**Implementation surface:**

- `export function resolveSwapParams(input: ExecuteSwapInput): ResolvedSwapParams` (defaults + validation; throws `AppError("invalid_input")`)
- `export function pctToFraction(pct: number): number`
- `export function checkDrift(freshOut: bigint, expectedAmountOut: bigint | undefined, slippageTolerancePct: number): { abort: boolean }` (bigint math: `freshOut < expected − expected × tolBps / 10000n` style — no float on amounts)
- `export type ExecuteSwapInput = { direction: "ETH_TO_USDC" | "USDC_TO_ETH"; amountIn: string; expectedAmountOut?: string; slippageTolerancePct?: number; deadlineSeconds?: number }`

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(services): pure safety rails with drift-floor math and slippage units`. Body: `TDD: test/node/rails.test.ts written before src/services/rails.ts.`

---

### Task 13: TradingApiClient — request/response shapes + routing assertion

**Domain:** general-purpose
**Files:**

- Create: `src/engine/tradingApiClient.ts`, `test/fixtures/tradingApi.ts` (fixtures: `/check_approval` null + non-null; `/quote` CLASSIC, WRAP, UNWRAP, and a DUTCH_V2-shaped body; `/swap` response)
- Test: `test/node/trading-api-shapes.test.ts`

**Test contract:**

- File: `test/node/trading-api-shapes.test.ts`
- Test names: `getQuote sends the EXACT_INPUT CLASSIC request contract`, `all calls carry required headers`, `routing-shape assertion fails closed on non-CLASSIC-family routing`, `quoted output is read via the routing-aware accessor`, `buildSwap spreads the quote and strips null permit fields`, `native ETH uses the zero-address sentinel`
- Assertions (fetch stubbed via injected `fetchImpl`; fixtures only):
  - `/quote` body has `type:"EXACT_INPUT"`, `tokenInChainId:"1"`, `tokenOutChainId:"1"` (strings), `routingPreference:"CLASSIC"`, `swapper`, base-unit `amount`, `slippageTolerance` as **percent** number (covers §7 G5)
  - every request carries `x-api-key` (via accessor), `Content-Type: application/json`, `x-universal-router-version: 2.0`, and targets `TRADING_API_BASE_URL` (covers G5)
  - a DUTCH_V2-routing fixture makes `getQuote` throw `AppError("upstream_unavailable")` **before** any output field is read (covers §7 G5 routing assertion — fail closed)
  - `readQuotedOutput(classicFixture) === fixture.quote.output.amount` for CLASSIC/WRAP/UNWRAP — accessor is routing-aware, never a bare property read on unasserted shapes (covers §7 G5)
  - `buildSwap` request body is the quote response spread at top level (not nested under `quote`), with `permitData: null` / `permitTransaction: null` keys absent; result is `{ to, data, value, chainId, gasLimit }` with `to === UNIVERSAL_ROUTER_ADDRESS` (covers §7 G5)
  - ETH-side token in requests is `NATIVE_ETH_SENTINEL` for ETH_TO_USDC input / USDC_TO_ETH output (covers G5)

**Expected first-run failure:** `Cannot find module '../../src/engine/tradingApiClient'`.

**Implementation surface:**

- `export interface TradingApiClient { checkApproval(i: { token: string; amount: string; walletAddress: string }): Promise<{ approval: unknown | null }>; getQuote(i: QuoteInput): Promise<ClassicQuoteResponse>; buildSwap(q: ClassicQuoteResponse): Promise<SwapTx> }`
- `export function createTradingApiClient(deps: { baseUrl: string; getApiKey: () => string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; random?: () => number }): TradingApiClient`
- `export function readQuotedOutput(q: ClassicQuoteResponse): string`
- `export function assertClassicFamilyRouting(q: { routing: string }): asserts q is ClassicQuoteResponse` (throws `AppError("upstream_unavailable")` unless routing ∈ {CLASSIC, WRAP, UNWRAP})
- Types: `QuoteInput`, `ClassicQuoteResponse` (discriminated on `routing`), `SwapTx = { to: string; data: string; value: string; chainId: number; gasLimit: string }`

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(engine): trading api client request contract with routing-shape assertion`. Body: `TDD: test/node/trading-api-shapes.test.ts written before src/engine/tradingApiClient.ts.`

---

### Task 14: TradingApiClient — 8s timeout + jittered retry policy

**Domain:** general-purpose
**Files:**

- Modify: `src/engine/tradingApiClient.ts`
- Test: `test/node/trading-api-retry.test.ts`

**Test contract:**

- File: `test/node/trading-api-retry.test.ts` (vitest fake timers; injected `sleep`/`random`)
- Test names: `a call exceeding 8s maps to upstream_unavailable`, `quote and check_approval retry at most twice on 429/5xx with 250ms then 500ms jittered backoff`, `swap is never retried`, `4xx other than 429 does not retry`
- Assertions:
  - a `fetchImpl` that never resolves within 8s (fake timers) causes `AppError("upstream_unavailable")`; the per-call timeout is 8000ms (covers §7 G5 timeout)
  - a `fetchImpl` returning 500, 500, 200 for `/quote` results in success with exactly 3 fetch calls; recorded `sleep` delays derive from bases 250ms then 500ms with jitter applied via the injected `random` (assert delay ∈ [base, base×2) or the chosen jitter formula, pinned) (covers §7 G5 retry policy)
  - after 3 failures (initial + 2 retries) `/quote` throws `AppError("upstream_unavailable")` (covers G5)
  - `/check_approval` retries identically; `/swap` with a 500 fails immediately with exactly 1 fetch call — never retried, no double-submission (covers §7 G5 `/swap` never retries)
  - a 400 on `/quote` fails without retry (covers G5 — only 429/5xx retry)

**Expected first-run failure:** assertion failure — `/quote` currently makes exactly 1 call and surfaces the raw failure (no retry/timeout layer yet).

**Implementation surface:** internal `requestWithPolicy(path, body, { retryable: boolean })` inside `createTradingApiClient` — 8s `AbortSignal.timeout`-style bound via injected timer seam; ≤2 retries with jittered exponential backoff for `/quote` and `/check_approval` only.

**Expected pass criteria:** T13 + T14 green; gate green.

- [ ] Steps 1–6. Commit: `feat(engine): 8s timeout and bounded jittered retries for idempotent trading api calls`. Body: `TDD: test/node/trading-api-retry.test.ts written before the retry layer.`

---

### Task 15: ViemSigner — direction-aware balances, submit, receipt disambiguation

**Domain:** general-purpose
**Files:**

- Create: `src/engine/viemSigner.ts`, `test/fixtures/receipts.ts` (success receipt, reverted receipt, timeout-throw variant)
- Test: `test/node/viem-signer.test.ts`

**Test contract:**

- File: `test/node/viem-signer.test.ts` (viem clients replaced via an injected `clientFactory` returning fakes — no RPC)
- Test names: `getNativeBalance reads native ETH via getBalance`, `getErc20Balance reads USDC balanceOf`, `sendTransaction signs and submits returning the hash`, `waitForReceipt distinguishes success, revert and timeout`, `clients are created per call, not at module scope`, `estimateMaxFeePerGas surfaces the fee estimate`
- Assertions:
  - `getNativeBalance(addr)` delegates to the fake public client's `getBalance` and returns its bigint (18-decimals source for ETH→USDC input — covers §7 G5 direction-aware balances)
  - `getErc20Balance(USDC_ADDRESS, addr)` calls `readContract` with `functionName:"balanceOf"` on `USDC_ADDRESS` and returns the bigint (6-decimals source for USDC→ETH input — covers §7 G5)
  - `sendTransaction({ to, data, value })` uses an account derived via `privateKeyToAccount(getPrivateKey())` and returns the fake hash; the private key is obtained through the accessor at call time, never stored on the signer object (covers G5/G10 — `JSON.stringify(signer)` contains no key material)
  - `waitForReceipt(hash, timeoutMs)`: fake receipt `status:"success"` → `{ kind: "success", gasUsed }`; `status:"reverted"` → `{ kind: "reverted" }`; a `WaitForTransactionReceiptTimeoutError`-named throw → `{ kind: "timeout" }` — three distinct outcomes, timeout never conflated with revert (covers §7 G3/G7/G8 timeout-vs-revert; M3)
  - the injected `clientFactory` is invoked on each signer method call (per-request clients — covers §5.8/§5.9 constraint; scaffolding)
  - `estimateMaxFeePerGas()` returns the fake fee-estimate bigint (scaffolding for the M1 gas-headroom rail in T17)

**Expected first-run failure:** `Cannot find module '../../src/engine/viemSigner'`.

**Implementation surface:**

- `export interface ViemSigner { address: string; getNativeBalance(addr: string): Promise<bigint>; getErc20Balance(token: string, addr: string): Promise<bigint>; estimateMaxFeePerGas(): Promise<bigint>; sendTransaction(tx: { to: string; data: string; value: string }): Promise<string>; waitForReceipt(hash: string, timeoutMs: number): Promise<ReceiptOutcome> }`
- `export type ReceiptOutcome = { kind: "success"; gasUsed: bigint } | { kind: "reverted" } | { kind: "timeout" }`
- `export function createViemSigner(deps: { getPrivateKey: () => string; getRpcUrl: () => string; clientFactory?: ClientFactory }): ViemSigner` (default factory: `createPublicClient`/`createWalletClient` with `chain: mainnet`, `transport: http(getRpcUrl())`, per call; `waitForTransactionReceipt({ hash, timeout })` with timeout in ms — confirmed current viem 2.55 API)

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(engine): viem signer with direction-aware balances and receipt disambiguation`. Body: `TDD: test/node/viem-signer.test.ts written before src/engine/viemSigner.ts.`

---

### Task 16: swapService.getQuote

**Domain:** general-purpose
**Files:**

- Create: `src/services/swapService.ts`
- Test: `test/node/swap-service-quote.test.ts`

**Test contract:**

- File: `test/node/swap-service-quote.test.ts` (fake `TradingApiClient`)
- Test names: `getQuote returns quoted output reusable as expectedAmountOut`, `getQuote includes a ~30s freshness hint`, `getQuote never writes the database`, `getQuote maps direction to token pair`
- Assertions:
  - `getQuote(deps, { direction: "ETH_TO_USDC", amountIn: "1000000000000000000" })` returns `{ quotedAmountOut }` equal to the CLASSIC fixture's output amount as a base-unit string — byte-identical to what `execute_swap` accepts as `expectedAmountOut` (covers §7 G3 reusable-floor form)
  - the result carries `createdAt` and `freshUntil = createdAt + 30_000` (service-computed hint; the API has no expiry field) plus price and the applied `slippageTolerancePct` default 0.5 (covers §5.7 get_quote — G3)
  - the fake repo/db seam is never touched (spy: zero calls) (covers §7 G3 no-DB-write)
  - `ETH_TO_USDC` maps `tokenIn = NATIVE_ETH_SENTINEL`, `tokenOut = USDC_ADDRESS`; `USDC_TO_ETH` the reverse (covers G5)

**Expected first-run failure:** `Cannot find module '../../src/services/swapService'`.

**Implementation surface:**

- `export type SwapServiceDeps = { tradingApi: TradingApiClient; signer: ViemSigner; repo: TransactionsRepository; now?: () => number }`
- `export async function getQuote(deps: Pick<SwapServiceDeps, "tradingApi" | "now">, input: { direction: Direction; amountIn: string }): Promise<QuoteResult>`
- `export type QuoteResult = { direction: Direction; amountIn: string; quotedAmountOut: string; price: string; slippageTolerancePct: number; createdAt: number; freshUntil: number }`

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(services): quote service with reusable expectedAmountOut output`. Body: `TDD: test/node/swap-service-quote.test.ts written before swapService.getQuote.`

---

### Task 17: swapService.executeSwap orchestration + gas-headroom balance rail

**Domain:** general-purpose
**Files:**

- Modify: `src/services/swapService.ts`
- Test: `test/node/swap-service-execute.test.ts`

**Test contract:**

- File: `test/node/swap-service-execute.test.ts` (fake `TradingApiClient` + fake `ViemSigner` + in-memory fake `TransactionsRepository` recording transitions)
- Test names: `happy path transitions pending→submitted→confirmed`, `re-quote happens immediately before submission and is routing-asserted`, `caller drift floor aborts with slippage_exceeded and no transaction`, `omitted floor never drift-aborts`, `USDC→ETH non-null approval aborts approval_required without any transaction`, `ETH→USDC skips check_approval`, `ETH→USDC balance rail requires amountIn plus gas headroom`, `USDC→ETH balance rail checks erc20 input and native gas separately`, `rail failures write pending→failed with errorCode and no txHash`
- Assertions:
  - happy path: repo sees `insertPending` → `markSubmitted(txHash)` → `markConfirmed({ actualAmountOut, gasUsed })` in order; result `{ status: "confirmed", result: "ok", txHash, transactionId, actualAmountOut, gasUsed }` (covers §7 G3/G8)
  - `tradingApi.getQuote` is called inside `executeSwap` (never reuses a client quote) with `slippageTolerance` = resolved pct; a DUTCH_V2 re-quote fixture aborts `upstream_unavailable` with the row marked failed (covers §5.8 step 2 / G5)
  - with `expectedAmountOut` supplied and fresh output below `expected × (1 − tol)`: result failed `slippage_exceeded`, repo shows `pending→failed` with `errorCode:"slippage_exceeded"` and no `txHash`, and `signer.sendTransaction` was never called (covers §7 G3/G6/G8)
  - with `expectedAmountOut` omitted and a heavily-drifted fresh quote: **no** drift abort — flow proceeds to `/swap`; the service computes/carries no `amountOutMinimum` field anywhere (assert the `/swap` request equals the spread quote) (covers §7 G3/G6 omitted-floor)
  - USDC_TO_ETH with non-null `/check_approval` fixture: abort `approval_required`, `pending→failed`, no swap tx and **no approval tx** sent (`sendTransaction` never called) (covers §7 G3/G6 approval gating; M4)
  - ETH_TO_USDC: `checkApproval` spy has zero calls (covers §5.8 step 4)
  - ETH_TO_USDC with `nativeBalance = amountIn` exactly: `insufficient_balance` (needs `amountIn + gasLimit × maxFeePerGas + buffer`); with generous balance it passes (covers §7 G5/G6 gas headroom — M1)
  - USDC_TO_ETH with `erc20Balance < amountIn` → `insufficient_balance`; with sufficient USDC but native balance below `gasLimit × maxFeePerGas` → `insufficient_balance` (covers §7 G5/G6 direction-aware rail — M2)
  - `slippageTolerancePct: 6` and `amountIn: "0"` each produce a failed row with `invalid_input` and no tx (covers §7 G6/G8 rail disposition — M6)

**Expected first-run failure:** `executeSwap is not a function` (module exports only `getQuote`).

**Implementation surface:**

- `export async function executeSwap(deps: SwapServiceDeps, input: ExecuteSwapInput & { userId: string }): Promise<SwapResult>` — implements §5.8 steps 1–8 sans mutex (mutex lives in the DO, T21): insert pending → re-quote (assert routing) → drift check (T12 `checkDrift`) → approval gate (USDC→ETH only) → rails incl. balance+gas headroom → `buildSwap` → sign/submit → `markSubmitted` → `waitForReceipt(hash, deadlineSeconds × 1000)` → confirm/fail/timeout mapping (timeout handling asserted in T20 at DO level and here at unit level: `kind:"timeout"` → row untouched after `submitted`, result `timed_out`)
- `export type SwapResult = { transactionId: string; status: "confirmed" | "failed" | "submitted"; result: "ok" | "timed_out"; txHash?: string; quotedAmountOut?: string; actualAmountOut?: string; gasUsed?: string; errorCode?: ErrorCode }`

**Expected pass criteria:** all nine tests green; gate green.

- [ ] Steps 1–6. Commit: `feat(services): executeSwap orchestration with drift, approval and balance rails`. Body: `TDD: test/node/swap-service-execute.test.ts written before swapService.executeSwap.`

---

### Task 18: SwapCoordinator DO — class, binding, happy-path lifecycle

**Domain:** general-purpose
**Files:**

- Create: `src/coordinator/SwapCoordinator.ts`
- Modify: `wrangler.jsonc` (add DO binding `SWAP_COORDINATOR` → class `SwapCoordinator`; add/extend `migrations` block `new_sqlite_classes: ["SwapCoordinator"]`), `src/index.ts` (export the class), run `pnpm cf-typegen`
- Test: `test/workers/coordinator-lifecycle.test.ts`

**Test contract:**

- File: `test/workers/coordinator-lifecycle.test.ts` (real DO via `env.SWAP_COORDINATOR` stub; fakes injected by assigning `instance.deps` inside `runInDurableObject` before invoking — the DO exposes a `deps` field defaulting to real clients built lazily from `this.env`)
- Test names: `executeSwap RPC drives pending→submitted→confirmed in D1`, `every transition is written eagerly before the call returns`, `deps default to env-built clients but are injectable for tests`
- Assertions:
  - `await stub.executeSwap(params)` (with fake engine deps) returns `{ status: "confirmed", result: "ok", txHash, transactionId }` and the D1 row (read via repository against `env.DB`) is `confirmed` with `quotedAmountOut`, `actualAmountOut`, `gasUsed`, `submittedAt`, `settledAt` populated (covers §7 G7/G8)
  - a fake signer whose `waitForReceipt` first asserts (via direct D1 read from inside the fake) that the row is already `submitted` with `txHash` — proves eager write precedes receipt wait (covers §7 G9 eager writes)
  - without injection, accessing `instance.deps` lazily constructs real clients using the secret accessors and never stores the private key as a plain field (assert `JSON.stringify` of the instance snapshot excludes key material) (covers §5.8/G10; scaffolding)

**Expected first-run failure:** workers pool boot error / `env.SWAP_COORDINATOR is undefined` before the class + binding exist; after scaffolding the class, `executeSwap is not a function`.

**Implementation surface:**

- `export class SwapCoordinator extends DurableObject<CloudflareBindings> { deps?: SwapServiceDeps; async executeSwap(params: ExecuteSwapInput & { userId: string }): Promise<SwapResult> }` — builds `deps ??= createDefaultDeps(this.env)` (drizzle over `this.env.DB`, `createTradingApiClient`, `createViemSigner` with accessors from `validateEnv(this.env)`); delegates to `swapService.executeSwap`; per-request client creation preserved by the T15 factory design
- `wrangler.jsonc`: `durable_objects.bindings: [{ name: "SWAP_COORDINATOR", class_name: "SwapCoordinator" }]`, `migrations: [{ tag: "v1", new_sqlite_classes: ["SwapCoordinator"] }]`

**Expected pass criteria:** green; T2 canary still green; `pnpm cf-typegen` regenerated; gate green.

- [ ] Steps 1–6 (write test → red → class + wiring → green → gate → commit). Commit: `feat(coordinator): SwapCoordinator durable object with eager D1 lifecycle writes`. Body: `TDD: test/workers/coordinator-lifecycle.test.ts written before src/coordinator/SwapCoordinator.ts.`

---

### Task 19: Coordinator abort paths — drift, approval, rails disposition

**Domain:** general-purpose
**Files:**

- Test: `test/workers/coordinator-aborts.test.ts` (no new implementation expected — this is the workers-pool proof over the real DO + real D1 that T17's node-level behavior holds end-to-end; any divergence found is fixed in `src/coordinator/SwapCoordinator.ts` / `src/services/swapService.ts`)

**Test contract:**

- File: `test/workers/coordinator-aborts.test.ts`
- Test names: `caller drift floor aborts slippage_exceeded writing a failed row with no txHash`, `omitted floor proceeds without drift abort`, `USDC→ETH missing approval aborts approval_required without sending anything`, `gas-headroom shortfall aborts insufficient_balance`, `rail abort leaves exactly one failed row (pending→failed)`
- Assertions:
  - each abort path returns the matching `errorCode`, and the D1 row is `status:"failed"`, `errorCode` set, `txHash` null; fake signer's `sendTransaction` spy shows zero calls (covers §7 G3/G6/G8)
  - omitted-floor case reaches `buildSwap` and submits (spy: one `sendTransaction`) (covers §7 G3)
  - exactly one row exists per attempt — the pending row is transitioned, never deleted or duplicated (covers §7 G8 one-row-per-attempt)

**Expected first-run failure:** if T17/T18 are correct these pass immediately — therefore **Step 1 deliberately breaks one expectation first** (e.g. asserts an intentionally-wrong errorCode) to watch the test fail for the right reason, then corrects the assertion; any genuinely-red assertion indicates a coordinator-level gap to fix. This is the sanctioned way to satisfy watch-it-fail on an integration-breadth test whose logic already exists.

**Implementation surface:** none expected; fixes land in existing modules if red.

**Expected pass criteria:** all five green; gate green.

- [ ] Steps 1–6. Commit: `test(coordinator): workers-pool proof of drift, approval and rail abort dispositions`. Body: `TDD: test/workers/coordinator-aborts.test.ts drives the coordinator against real D1; red verified via deliberate assertion inversion.`

---

### Task 20: Receipt-wait timeout vs revert disambiguation (M3)

**Domain:** general-purpose
**Files:**

- Modify: `src/services/swapService.ts` / `src/coordinator/SwapCoordinator.ts` (whatever the red reveals)
- Test: `test/workers/coordinator-receipt.test.ts`

**Test contract:**

- File: `test/workers/coordinator-receipt.test.ts`
- Test names: `receipt timeout leaves the row submitted with txHash and returns result timed_out`, `revert writes failed with swap_failed keeping txHash`, `timeout is never written as failed`, `receipt wait is bounded by deadlineSeconds`
- Assertions:
  - fake signer `waitForReceipt` → `{ kind: "timeout" }`: call result `{ status: "submitted", result: "timed_out", txHash }`; D1 row remains `status:"submitted"` with `txHash`, `errorCode` null — no fifth status value anywhere (covers §7 G3/G8)
  - fake `{ kind: "reverted" }`: result `{ status: "failed" , errorCode: "swap_failed", txHash }`; D1 row `failed` **with** `txHash` retained (unlike pre-submit aborts) (covers §7 G3/G8 revert distinct from timeout)
  - after the timeout case, re-reading the row later still shows `submitted` (nothing downgraded it to failed) (covers §7 G3 timeout-never-failed)
  - the fake signer records `timeoutMs === deadlineSeconds × 1000` (default 1200s) (covers §7 G3/G4 receipt bound; decision 19)

**Expected first-run failure:** timeout case red if any conflation exists (e.g. result mapped to `failed`); otherwise apply the deliberate-inversion red check as in T19.

**Implementation surface:** branch in `executeSwap` on `ReceiptOutcome.kind` exactly as typed in T15 — no new symbols.

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(coordinator): disambiguate receipt timeout from revert with bounded wait`. Body: `TDD: test/workers/coordinator-receipt.test.ts written before the disambiguation branch was finalized.`

---

### Task 21: G7 concurrency mutex + G9 mid-swap interleaving

**Domain:** general-purpose
**Files:**

- Modify: `src/coordinator/SwapCoordinator.ts` (add the promise-chain mutex)
- Test: `test/workers/coordinator-concurrency.test.ts`

**Test contract:**

- File: `test/workers/coordinator-concurrency.test.ts`
- Test names: `two concurrent executeSwap calls are serialized by the in-DO promise chain`, `no overlapping submit and nonce order preserved`, `get-path reads see submitted status before execute_swap returns`
- Assertions:
  - two `stub.executeSwap` promises fired without awaiting: a fake signer that records enter/exit timestamps around `sendTransaction`+`waitForReceipt` (with an injected delay) proves the second swap's engine work begins only after the first fully settles — serialization via a promise chain, **not** `blockConcurrencyWhile` per request (implementation asserted by construction: the mutex is a `tail: Promise<unknown>` field the method chains onto) (covers §7 G7)
  - submitted tx order (fake nonce counter incremented in `sendTransaction`) matches call order — no interleaved submissions (covers §7 G7)
  - interleaving: while swap A is parked inside the fake `waitForReceipt`, the test (from outside the DO) calls `createTransactionsRepository(drizzle(env.DB)).findById(idA)` and observes `status: "submitted"` **before** the `executeSwap` promise resolves (covers §7 G9 — the dedicated mid-swap live-visibility row)

**Expected first-run failure:** overlap detected — enter/exit windows of the two fake submits intersect (no mutex yet).

**Implementation surface:**

- private field `#tail: Promise<unknown> = Promise.resolve()`; `executeSwap` wraps its body: `const run = this.#tail.then(doWork, doWork); this.#tail = run.catch(() => {}); return run` — single-flight promise-chain mutex per §5.8

**Expected pass criteria:** all three green; T18–T20 still green; gate green.

- [ ] Steps 1–6. Commit: `feat(coordinator): promise-chain single-flight mutex with live mid-swap visibility`. Body: `TDD: test/workers/coordinator-concurrency.test.ts written before the mutex.`

---

### Task 22: MCP read-tool registrars — get_quote, get_transaction, list_transactions

**Domain:** general-purpose
**Files:**

- Create: `src/mcp/tools/getQuote.ts`, `src/mcp/tools/getTransaction.ts`, `src/mcp/tools/listTransactions.ts`, `src/mcp/tools/deps.ts` (shared `ToolDeps` type)
- Test: `test/workers/mcp-read-tools.test.ts`

**Test contract:**

- File: `test/workers/mcp-read-tools.test.ts` (registrars invoked against a real `McpServer` from `@modelcontextprotocol/sdk` connected over the SDK's in-memory transport pair; deps faked; props supplied via `getProps` thunk)
- Test names: `get_quote returns quoted output and freshness in text + structuredContent`, `get_quote requires swap:read`, `get_transaction returns the live row`, `get_transaction returns not_found envelope for unknown id`, `list_transactions paginates with nextCursor and rejects tampered cursors`, `all failures pass through toErrorEnvelope`, `input schemas are bare Zod v4 raw shapes`
- Assertions:
  - calling tool `get_quote` with `{ direction: "ETH_TO_USDC", amountIn: "1000000000000000000" }` returns `{ content: [{ type: "text", ... }], structuredContent }` where `structuredContent.quotedAmountOut` equals the fixture output — directly reusable as `expectedAmountOut` (covers §7 G3)
  - with `getProps()` returning scopes `[]`, `get_quote` returns the `toErrorEnvelope("forbidden", ...)` shape with `isError: true` (covers §7 G2/G10 scope gate)
  - `get_transaction { id }` surfaces the repo row incl. current `status` (covers §7 G3/G9); unknown id → envelope code `not_found` (covers G10)
  - `list_transactions {}` on 25 seeded rows returns 20 + `nextCursor`; `{ cursor: tampered }` → envelope `invalid_input`; `{ limit: 500 }` capped at 100 (covers §7 G3)
  - a thrown fake-repo error surfaces as envelope code `internal` with no raw message text (covers §7 G10)
  - registration passes a plain object of Zod validators (ZodRawShape), not `z.object(...)` (scaffolding — spec §5.7 Zod v4 requirement)

**Expected first-run failure:** `Cannot find module '../../src/mcp/tools/getQuote'`.

**Implementation surface:**

- `export type ToolDeps = { getProps: () => AuthProps; service: { getQuote: typeof getQuote }; coordinator: { executeSwap(p: ExecuteSwapInput & { userId: string }): Promise<SwapResult> }; repo: TransactionsRepository }`
- `export function registerGetQuote(server: McpServer, deps: ToolDeps): void`
- `export function registerGetTransaction(server: McpServer, deps: ToolDeps): void`
- `export function registerListTransactions(server: McpServer, deps: ToolDeps): void`
- each handler: `requireScope(deps.getProps(), "swap:read")` → work → `{ content, structuredContent }`; catch-all → `toErrorEnvelope(classify(e), curatedMessage(code))`

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(mcp): read tool registrars with scope gating and error envelopes`. Body: `TDD: test/workers/mcp-read-tools.test.ts written before the registrars.`

---

### Task 23: MCP execute_swap registrar

**Domain:** general-purpose
**Files:**

- Create: `src/mcp/tools/executeSwap.ts`
- Test: `test/workers/mcp-execute-tool.test.ts`

**Test contract:**

- File: `test/workers/mcp-execute-tool.test.ts` (same harness as T22; coordinator faked)
- Test names: `execute_swap requires swap:write`, `execute_swap forwards the full input including optional expectedAmountOut`, `execute_swap returns terminal payload with result field`, `coordinator failures surface as envelopes`
- Assertions:
  - props with only `swap:read` → envelope `forbidden`, coordinator spy untouched (covers §7 G2 read-only-token rejected by write path)
  - input `{ direction, amountIn, expectedAmountOut, slippageTolerancePct, deadlineSeconds }` reaches the fake coordinator verbatim plus `userId: SINGLE_USER_ID` from props (covers §7 G3; decision 23)
  - a fake coordinator returning a confirmed `SwapResult` yields `structuredContent` containing `{ status, result, txHash, actualAmountOut, gasUsed, transactionId }`; a `timed_out` result passes through with `status:"submitted"` (covers §7 G3)
  - fake coordinator throwing `AppError("insufficient_balance")` → envelope code `insufficient_balance`, no raw message (covers G10)

**Expected first-run failure:** `Cannot find module '../../src/mcp/tools/executeSwap'`.

**Implementation surface:** `export function registerExecuteSwap(server: McpServer, deps: ToolDeps): void` (schema: bare raw shape with optional `expectedAmountOut: z.string()`, `slippageTolerancePct: z.number()`, `deadlineSeconds: z.number()`)

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(mcp): execute_swap tool registrar with write-scope enforcement`. Body: `TDD: test/workers/mcp-execute-tool.test.ts written before the registrar.`

---

### Task 24: SwapMcpAgent class + DO binding

**Domain:** general-purpose
**Files:**

- Create: `src/mcp/SwapMcpAgent.ts`
- Modify: `wrangler.jsonc` (DO binding `SWAP_MCP_AGENT` → class `SwapMcpAgent`? **No** — the `agents` McpAgent convention binds by class name for `.serve()`: add binding `{ name: "SwapMcpAgent", class_name: "SwapMcpAgent" }` and extend the migrations tag with `new_sqlite_classes: ["SwapMcpAgent"]`), `src/index.ts` (export class), `pnpm cf-typegen`
- Test: `test/workers/mcp-agent.test.ts`

**Test contract:**

- File: `test/workers/mcp-agent.test.ts`
- Test names: `init registers exactly the four tools`, `getProps is a live thunk over this.props`, `agent boots as a SQLite-backed DO`
- Assertions:
  - after `init()`, the agent's `server` lists tools exactly `["get_quote","execute_swap","list_transactions","get_transaction"]` (covers §7 G3 tool surface; via `runInDurableObject` or direct instance construction)
  - mutating the props the agent holds between two tool invocations changes what the handler's `getProps()` observes — the thunk is `() => this.props`, never a value captured at init (covers §5.7 live-thunk requirement — G2/G3)
  - the DO binding exists and `env.SwapMcpAgent.idFromName("test")` yields a stub (scaffolding for G1)

**Expected first-run failure:** `Cannot find module '../../src/mcp/SwapMcpAgent'` / missing binding boot error.

**Implementation surface:**

- `export class SwapMcpAgent extends McpAgent<CloudflareBindings, unknown, AuthProps> { server = new McpServer({ name: "swap-mcp", version: "1.0.0" }); async init(): Promise<void> }` — `init()` builds request-invariant deps (validateEnv, drizzle repo, engine clients, coordinator stub factory) and calls the four registrars with `getProps: () => this.props`

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(mcp): SwapMcpAgent durable object wiring the four tools`. Body: `TDD: test/workers/mcp-agent.test.ts written before src/mcp/SwapMcpAgent.ts.`

---

### Task 25: REST props-adapter middleware + error→HTTP mapping

**Domain:** general-purpose
**Files:**

- Create: `src/api/middleware/props.ts`
- Test: `test/workers/api-middleware.test.ts`

**Test contract:**

- File: `test/workers/api-middleware.test.ts` (a throwaway Hono app exercised via `app.request(path, init, envWithExecutionCtx)` where the execution context carries fake `props`)
- Test names: `middleware threads executionCtx.props into c.get("props")`, `missing props yields 401 unauthorized envelope`, `errorCodeToHttpStatus maps every allowlisted code`
- Assertions:
  - a route reading `c.get("props")` sees the identity placed on `c.executionCtx.props` — the single thread-point; the route never touches `executionCtx` (covers §7 G4 props threading — M9)
  - absent props → HTTP 401 with body `{ error: { code: "unauthorized", message } }` (covers G2/G10)
  - `errorCodeToHttpStatus`: `invalid_input→400, unauthorized→401, forbidden→403, not_found→404, slippage_exceeded→409, insufficient_balance→409, approval_required→409, upstream_unavailable→502, rate_limited→429, swap_failed→502, internal→500` — total over `ERROR_CODES` (covers §5.12/G10; `rate_limited→429` and `approval_required→409` per spec examples)

**Expected first-run failure:** `Cannot find module '../../src/api/middleware/props'`.

**Implementation surface:**

- `export const propsAdapter: MiddlewareHandler` (reads `c.executionCtx.props`, `c.set("props", props)`, 401 envelope when absent)
- `export function errorCodeToHttpStatus(code: ErrorCode): number`
- `export function errorResponse(c: Context, err: unknown): Response` (classify → envelope → status)

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(api): props adapter middleware and error-to-status mapping`. Body: `TDD: test/workers/api-middleware.test.ts written before src/api/middleware/props.ts.`

---

### Task 26: REST mirror routes (4)

**Domain:** general-purpose
**Files:**

- Create: `src/api/apiApp.ts`, `src/api/routes/quote.ts`, `src/api/routes/swap.ts`, `src/api/routes/transactions.ts`
- Test: `test/workers/api-routes.test.ts`

**Test contract:**

- File: `test/workers/api-routes.test.ts` (`createApiApp(fakeDeps)` exercised via `app.request` with fake props on the execution context)
- Test names: `POST /api/quote mirrors get_quote payload`, `POST /api/swap enforces swap:write and forwards expectedAmountOut`, `POST /api/swap surfaces timed_out with row still submitted`, `GET /api/transactions paginates with nextCursor`, `GET /api/transactions rejects tampered cursor with 400`, `GET /api/transactions/:id returns the live row and 404 on unknown`, `error codes map to matching HTTP statuses`
- Assertions:
  - `POST /api/quote` (scope `swap:read`) returns the same JSON shape as the MCP `get_quote` `structuredContent`, incl. `quotedAmountOut` reusable as `expectedAmountOut` (covers §7 G4)
  - `POST /api/swap` with props scopes `["swap:read"]` → 403 forbidden; with write scope forwards `{ direction, amountIn, expectedAmountOut?, slippageTolerancePct?, deadlineSeconds? } + userId` to the fake coordinator and returns the `SwapResult` payload identical in shape to MCP `execute_swap` (covers §7 G4 read-only rejection + floor)
  - fake coordinator returning `{ status: "submitted", result: "timed_out", txHash }` passes through as-is (covers §7 G4 timeout mirror)
  - `GET /api/transactions?limit=&cursor=` mirrors repository pagination: default 20, cap 100, `nextCursor` in body; tampered cursor → 400 `invalid_input` (covers §7 G4/G3)
  - `GET /api/transactions/:id` → row JSON incl. current status; unknown → 404 `not_found` (covers §7 G4/G9)
  - `AppError("rate_limited")` thrown by a dep → 429; `approval_required` → 409 (covers §7 G4/G10 status mapping)

**Expected first-run failure:** `Cannot find module '../../src/api/apiApp'`.

**Implementation surface:**

- `export function createApiApp(deps: ApiDeps): Hono` where `ApiDeps = { service: { getQuote }, coordinator: { executeSwap }, repo: TransactionsRepository }` — mounts `propsAdapter` first, then the four routes; every route wraps work in `errorResponse`
- `export function buildDefaultApiDeps(env: CloudflareBindings): ApiDeps` (used by T31 wiring; delegates to `env.SWAP_COORDINATOR` stub)

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(api): REST mirror routes with identical scope and payload semantics`. Body: `TDD: test/workers/api-routes.test.ts written before src/api/apiApp.ts.`

---

### Task 27: publicApp + /healthz

**Domain:** general-purpose
**Files:**

- Create: `src/oauth/publicApp.ts`
- Test: `test/workers/healthz.test.ts`

**Test contract:**

- File: `test/workers/healthz.test.ts`
- Test names: `GET /healthz returns 200 with the constant body`, `healthz does not branch on env presence`
- Assertions:
  - `publicApp.request("/healthz")` → 200, body exactly `{"status":"ok"}`, no auth required (covers §7 G1)
  - the same request against an app given an **empty** env still returns the identical constant body — no env/binding oracle (covers §5.13 — G1)

**Expected first-run failure:** `Cannot find module '../../src/oauth/publicApp'`.

**Implementation surface:** `export const publicApp = new Hono()` with `GET /healthz` returning a constant literal (authorize routes arrive in T29/T30 on this same app).

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(oauth): public app with constant-body healthz`. Body: `TDD: test/workers/healthz.test.ts written before src/oauth/publicApp.ts.`

---

### Task 28: RateLimiter Durable Object

**Domain:** general-purpose
**Files:**

- Create: `src/ratelimit/RateLimiter.ts`
- Modify: `wrangler.jsonc` (DO binding `RATE_LIMITER` → class `RateLimiter`; extend migrations with `new_sqlite_classes: ["RateLimiter"]`), `src/index.ts` (export class), `pnpm cf-typegen`
- Test: `test/workers/rate-limiter.test.ts`

**Test contract:**

- File: `test/workers/rate-limiter.test.ts` (real DO stub; time controlled via an injectable `now` set through `runInDurableObject`)
- Test names: `per-IP budget denies the 6th failure within 10 minutes`, `global budget denies the 21st failure across IPs`, `windows are fixed 10-minute tumbling windows expiring lazily`, `recordSuccess resets the per-IP window but not the global budget`, `ceiling holds under concurrent checkAndConsume calls`, `reservations are fail-safe-closed`
- Assertions:
  - 5 × `checkAndConsume("1.2.3.4")` → `{ allowed: true }`; the 6th → `{ allowed: false, reason: "per_ip" }` (covers §7 G2 5/IP/10min)
  - 20 failures spread over 20 distinct IPs → 21st from a fresh IP → `{ allowed: false, reason: "global" }` (covers §7 G2 global 20/10min)
  - advancing the injected clock past the window start + 600s makes a previously-denied IP allowed again — a subsequent success is possible once the window expires (covers §7 G2 window expiry)
  - after 4 failures, `recordSuccess(ip)` then 5 more `checkAndConsume(ip)` are allowed (per-IP reset) while the global count still includes the original 4 (covers §5.6a/§5.17 — G2)
  - `await Promise.all(Array.from({length: 10}, () => stub.checkAndConsume(ip)))` yields exactly 5 allowed and 5 denied — DO serialization makes the ceiling atomic under concurrency (covers §7 G2 ceiling-holds-concurrently)
  - `checkAndConsume` consumes at reservation time — a caller that never reports an outcome still counts as a failure (fail-safe-closed; asserted by consuming 5 reservations with no follow-up then observing denial) (covers §5.6a reservation semantics — G2)

**Expected first-run failure:** missing binding/class boot error, then `checkAndConsume is not a function`.

**Implementation surface:**

- `export class RateLimiter extends DurableObject<CloudflareBindings> { now: () => number; async checkAndConsume(ip: string): Promise<{ allowed: boolean; reason?: "per_ip" | "global" }>; async recordSuccess(ip: string): Promise<void> }` — DO storage keys: `ip:<ip> = { windowStart, count }`, `global = { windowStart, count }`; lazy expiry on read; no alarms

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(ratelimit): strongly consistent RateLimiter durable object`. Body: `TDD: test/workers/rate-limiter.test.ts written before src/ratelimit/RateLimiter.ts.`

---

### Task 29: CSRF codec + consent GET (display, redirect + resource validation)

**Domain:** general-purpose
**Files:**

- Create: `src/oauth/csrf.ts`
- Modify: `src/oauth/publicApp.ts` (add `GET /authorize`)
- Test: `test/workers/consent-get.test.ts`

**Test contract:**

- File: `test/workers/consent-get.test.ts` (publicApp exercised with a fake `env.OAUTH_PROVIDER` helpers object — `parseAuthRequest`, `lookupClient` — plus real `env.OAUTH_KV`)
- Test names: `csrf token is single-use and bound to the AuthRequest`, `GET /authorize renders client name and exact redirect_uri with a hidden csrf field`, `unregistered redirect_uri is rejected before rendering`, `foreign resource parameter is rejected at consent time`
- Assertions:
  - `issueCsrfToken(kv, authRequest)` stores a short-TTL (600s) nonce keyed to a hash of the AuthRequest fields; `verifyAndConsumeCsrfToken` succeeds once and fails on replay; a token issued for AuthRequest A fails verification against AuthRequest B (covers §7 G2 CSRF binding + single-use — B4)
  - the GET response HTML contains the fake client's registered `client_name` and the **exact** `redirect_uri` above the passphrase field, plus `<input type="hidden" name="csrf_token">` (covers §5.6b — G2 operator phishing check)
  - a `redirect_uri` not strictly matching a registered URI for the client → 400, no form rendered (covers §5.6b strict validation — G2)
  - a request whose `resource` parameter ≠ `CANONICAL_MCP_URI` → 400 rejection (covers §7 G2 foreign-resource rejection — M12)

**Expected first-run failure:** `Cannot find module '../../src/oauth/csrf'` / 404 on `/authorize`.

**Implementation surface:**

- `export async function issueCsrfToken(kv: KVNamespace, authRequest: AuthRequestLike): Promise<string>`
- `export async function verifyAndConsumeCsrfToken(kv: KVNamespace, token: string, authRequest: AuthRequestLike): Promise<boolean>` (delete-on-read)
- `publicApp.get("/authorize", ...)`: `c.env.OAUTH_PROVIDER.parseAuthRequest(req)` → `lookupClient(clientId)` → strict redirect_uri check → resource check → render Hono JSX consent page

**Expected pass criteria:** green; gate green.

- [ ] Steps 1–6. Commit: `feat(oauth): hardened consent screen with bound single-use CSRF token`. Body: `TDD: test/workers/consent-get.test.ts written before the consent GET handler.`

---

### Task 30: Consent POST — ordered gate chain + completeAuthorization

**Domain:** general-purpose
**Files:**

- Modify: `src/oauth/publicApp.ts` (add `POST /authorize`)
- Test: `test/workers/consent-post.test.ts`

**Test contract:**

- File: `test/workers/consent-post.test.ts` (fake `OAUTH_PROVIDER` helpers with a spying `completeAuthorization`; real `RateLimiter` DO; real `OAUTH_KV`)
- Test names: `disallowed Origin is rejected`, `invalid or replayed csrf token is rejected before the passphrase is evaluated`, `rate limiter is consulted before the passphrase compare and 429s when exhausted`, `correct passphrase completes authorization with exact props`, `wrong passphrase re-renders with error, mints nothing and consumes a failure`, `IP is read only from CF-Connecting-IP`
- Assertions:
  - POST with Origin outside `allowedOrigins` → 403; passphrase-compare spy shows zero invocations (covers §5.6 Origin allowlist — G2)
  - POST with missing/invalid/replayed CSRF token → rejection; a spy on the passphrase-compare seam proves it was **never called** (covers §7 G2 CSRF-before-passphrase)
  - after exhausting the per-IP budget via the real `RateLimiter`, the next POST returns HTTP 429 with envelope code `rate_limited` and the compare spy untouched (covers §7 G2 429-without-evaluating-passphrase)
  - correct passphrase (compared via `timingSafeEqualDigest` — asserted by spying the seam): `completeAuthorization` called once with `props` exactly `{ userId: SINGLE_USER_ID, scopes: ["swap:read","swap:write"], resource: <CANONICAL_MCP_URI> }` — `JSON.stringify(props)` contains no passphrase/key material (covers §7 G2 props content + no-secret + SHA-256-then-constant-time); `recordSuccess` called on the limiter
  - wrong passphrase: re-rendered form with an error message, `completeAuthorization` not called, limiter failure consumed (covers §7 G2 wrong-passphrase path)
  - the IP passed to `checkAndConsume` equals the `CF-Connecting-IP` header even when `X-Forwarded-For` differs (covers §7 G2 IP source)

**Expected first-run failure:** 404 on POST `/authorize`.

**Implementation surface:** `publicApp.post("/authorize", ...)` implementing the strict order: Origin/Referer allowlist → CSRF verify+consume → resource validation → `env.RATE_LIMITER` `checkAndConsume(CF-Connecting-IP)` → `timingSafeEqualDigest(submitted, getAuthPassphrase())` → on match `completeAuthorization` + `recordSuccess`, redirect; on mismatch re-render. Grants requested scopes ∩ `["swap:read","swap:write"]`, defaulting to both when the client requests both/none (both scopes co-granted at consent per §5.6; the intersection preserves §5.5's future read-only token with no code change).

**Expected pass criteria:** all six green; gate green.

- [ ] Steps 1–6. Commit: `feat(oauth): consent POST with ordered CSRF, rate-limit and timing-safe passphrase gates`. Body: `TDD: test/workers/consent-post.test.ts written before the consent POST handler.`

---

### Task 31: OAuthProvider wiring + integration happy path

**Domain:** general-purpose
**Files:**

- Modify: `src/index.ts` (default export becomes the provider; DO classes re-exported), `vitest.config.ts` (add third project `integration`: `cloudflareTest` plugin, include `test/integration/**/*.test.ts`, same setupFiles)
- Create: `test/helpers/mintToken.ts` (drives `/register` → `GET /authorize` (scrape CSRF) → `POST /authorize` → code→token exchange, all through `exports.default.fetch()`)
- Test: `test/integration/oauth-happy.test.ts`

**Test contract:**

- File: `test/integration/oauth-happy.test.ts`
- Test names: `well-knowns and register resolve publicly`, `unauthenticated /mcp and /api are rejected`, `healthz is public and constant`, `the full consent dance mints a token accepted by both surfaces`
- Assertions:
  - `GET /.well-known/oauth-authorization-server` → 200 JSON; `POST /register` accepts a client (open DCR — decision 24) (covers §7 G1)
  - `GET /api/transactions` and `POST /mcp` (JSON-RPC initialize) without a bearer → 401 (covers §7 G1)
  - `GET /healthz` → 200 `{"status":"ok"}` through the real default export (covers §7 G1)
  - `mintToken()` succeeds with the correct passphrase, allowed Origin and valid CSRF; the token then (a) authorizes `POST /mcp` JSON-RPC `initialize` + `tools/list` (with `MCP-Protocol-Version` + allowed Origin headers) listing the four tools, and (b) authorizes `GET /api/transactions` → 200 (covers §7 G1/G2 both-surfaces acceptance)
  - default export is an `OAuthProvider` instance (constructor identity or shape assertion) (covers §7 G1)

**Expected first-run failure:** `src/index.ts` still exports the scaffold Hono app — unauthenticated `/api` returns Hello-Hono 404/200 instead of 401, and well-knowns 404.

**Implementation surface:**

- `src/index.ts`: `export default new OAuthProvider({ apiHandlers: { "/mcp": SwapMcpAgent.serve("/mcp"), "/api": apiApp }, defaultHandler: publicApp, authorizeEndpoint: "/authorize", tokenEndpoint: "/token", clientRegistrationEndpoint: "/register", scopesSupported: ["swap:read","swap:write"] })` — `serve("/mcp")` with **no** `{ binding }` argument (spec M8; verified against `node_modules/agents/dist/mcp.d.ts` in T1 Step 3); token storage via the `env.OAUTH_KV` convention (no `kv` option exists in 0.8.1). `export { SwapMcpAgent, SwapCoordinator, RateLimiter }`. `apiApp` here is a thin Hono app calling `createApiApp(buildDefaultApiDeps(env))` per request; the MCP transport guard (`transportGuard`) runs in `SwapMcpAgent`'s fetch path before tool dispatch; `assertAudience` runs on props before every tool handler (already wired via registrars' deps).
- `test/helpers/mintToken.ts`: `export async function mintToken(opts?: { scope?: string }): Promise<{ accessToken: string; clientId: string }>`

**Expected pass criteria:** integration project green; all prior projects green; gate green.

- [ ] Steps 1–6. Commit: `feat(app): OAuthProvider entry wiring mcp and api surfaces with public consent`. Body: `TDD: test/integration/oauth-happy.test.ts written before rewiring src/index.ts.`

---

### Task 32: Integration negative paths

**Domain:** general-purpose
**Files:**

- Test: `test/integration/oauth-negative.test.ts` (fixes land in existing modules if red beyond expectation)

**Test contract:**

- File: `test/integration/oauth-negative.test.ts`
- Test names: `consent POST without a valid csrf token is rejected before passphrase evaluation`, `foreign resource at authorize is rejected`, `sixth failed passphrase from one IP returns 429`, `a swap:read-only token is rejected by execute_swap and POST /api/swap`, `minted token props carry no secret`, `redaction leak test end-to-end`
- Assertions:
  - replaying/omitting the CSRF token on the real `POST /authorize` → rejection; a subsequent GET+valid dance still works (covers §7 G2 CSRF integration path)
  - authorize request with `resource=https://attacker.example/mcp` → rejected; no token mintable (covers §7 G2 foreign-resource)
  - five wrong-passphrase POSTs from `CF-Connecting-IP: 9.9.9.9` then a sixth → HTTP 429 `rate_limited` (covers §7 G2 429-after-limit via the real `RateLimiter`)
  - `mintToken({ scope: "swap:read" })` (client requests only the read scope; consent grants the intersection) → the token succeeds on `GET /api/transactions` but `POST /api/swap` → 403 and the MCP `execute_swap` tool call returns the `forbidden` envelope (covers §7 G2/G4 read-only-token rejected by every write path)
  - decoding what the surfaces echo of identity (e.g. a transactions row's `userId`, MCP tool behavior) never exposes the passphrase or any secret; a forced `internal` error response body contains no long hex and no secret-name values (covers §7 G2 no-secret props + §7 G10 integration leak test)

**Expected first-run failure:** these exercise already-built behavior — apply the deliberate-inversion red check (invert one assertion, watch it fail, restore) per T19's note; any genuine red is a defect fixed in the named modules.

**Implementation surface:** none expected.

**Expected pass criteria:** all green; gate green.

- [ ] Steps 1–6. Commit: `test(integration): negative oauth, rate-limit, scope and redaction paths`. Body: `TDD: test/integration/oauth-negative.test.ts drives the full worker via exports.default.fetch().`

---

### Task 33: Documentation (Diátaxis)

**Domain:** general-purpose
**Files:**

- Create: `docs/tutorials/getting-started.md` — tutorial: stand up locally (`pnpm install`, `pnpm dev`), mint a token via the OAuth dance, run a mocked quote
- Create: `docs/how-to/configure-secrets-and-deploy.md` — how-to: set the four secrets via `wrangler secret put`, replace placeholder KV/D1/DO ids, deploy, run the smoke script
- Create: `docs/how-to/one-time-usdc-approval.md` — how-to: run the one-time legacy USDC→Universal Router `approve` out-of-band (the service never auto-sends it; `approval_required` recovery)
- Create: `docs/how-to/reconcile-stranded-submitted.md` — the named reconciliation runbook: look up the recorded `txHash` on-chain, determine the real outcome, mark the row `confirmed` (with `actualAmountOut`/`gasUsed`) or `failed` (with `errorCode`); **must state that a `pending` row with no `txHash` is safe to mark `failed`**
- Create: `docs/reference/api-and-data-model.md` — reference: MCP tool schemas (incl. optional `expectedAmountOut`, cursor, `result` field), the four REST endpoints, `swaps` columns + status lifecycle, the full 11-code error allowlist
- Create: `docs/explanation/architecture-decisions.md` — explanation: why OAuthProvider + McpAgent, RateLimiter DO over KV, SwapCoordinator serialization, drift-floor semantics (caller floor vs API-embedded floor), the `approval_required` no-auto-send stance, custodial trade-offs, why `timed_out` is a call result not a row status
- Test: `test/node/docs-presence.test.ts`

**Test contract:**

- File: `test/node/docs-presence.test.ts` (fs-based presence/content check — the concrete form of §7 G13's "integration presence check")
- Test names: `one artifact exists per Diátaxis quadrant`, `the reconciliation runbook exists by its spec-mandated name and notes the pending-row rule`, `the one-time approval how-to exists`, `reference covers the full error allowlist`
- Assertions:
  - each of the six files above exists and is non-empty (covers §7 G13 one-per-quadrant + named artifacts)
  - `docs/how-to/reconcile-stranded-submitted.md` contains the phrase matching /pending.*no.*txHash.*safe.*failed/i (covers §7 G13 pending-row note)
  - `docs/reference/api-and-data-model.md` mentions every member of `ERROR_CODES` (imported from `src/errors.ts` so the doc can never drift silently) (covers G13/G10)

**Expected first-run failure:** `ENOENT` — docs files absent.

**Implementation surface:** the six Markdown files, authored under the writing-documentation skill's Diátaxis discipline (grounded in the real code built in T1–T32; Strunk style rules; each doc serves one reader/one goal; no invented endpoints — every claim traceable to the implemented surface).

**Expected pass criteria:** presence test green; gate green.

- [ ] Steps 1–6 (test first, watch ENOENT, author docs, green, gate, commit). Commit: `docs: Diátaxis documentation set with approval and reconciliation how-tos`. Body: `TDD: test/node/docs-presence.test.ts written before the documentation files.`

---

### Task 34: Manual smoke script

**Domain:** general-purpose
**Files:**

- Create: `scripts/smoke.ts`
- Modify: `docs/how-to/configure-secrets-and-deploy.md` (link the smoke run step, mark manual-only)
- Test: `test/node/smoke-presence.test.ts`

**Test contract:**

- File: `test/node/smoke-presence.test.ts`
- Test names: `smoke script exists and is excluded from the automated suite`, `package exposes the smoke script via tsx`
- Assertions:
  - `scripts/smoke.ts` exists, is non-empty, and contains a manual-only banner comment (covers §7 G11 smoke exists + documented manual-only)
  - no file under `test/` imports `scripts/smoke.ts` (grep assertion) and `vitest` include globs cannot match `scripts/**` (covers §7 G11 zero real network in `pnpm test`)
  - `package.json` `smoke` script is `tsx scripts/smoke.ts` (scaffolding — §5.16)

**Expected first-run failure:** `ENOENT: scripts/smoke.ts`.

**Implementation surface:** `scripts/smoke.ts` (run under `tsx` against a deployed env; reads `SWAP_MCP_BASE_URL`, `AUTH_PASSPHRASE`, `UNISWAP_API_KEY`, `ETH_RPC_URL`, `SWAP_PRIVATE_KEY` from process env): mints a token through the real OAuth dance (register → authorize with passphrase → token), runs a tiny real ETH→USDC quote then swap via the deployed API, prints the persisted row from `GET /api/transactions/:id`; documents and optionally performs (behind an explicit `--approve` flag + confirmation prompt) the one-time USDC→Universal Router approval for the USDC→ETH direction. `pnpm typecheck` covers it; the suite never runs it.

**Expected pass criteria:** presence test green; `pnpm typecheck` (including `scripts/`) green; full suite green with zero network access.

- [ ] Steps 1–6. Commit: `feat(scripts): manual real-chain smoke script`. Body: `TDD: test/node/smoke-presence.test.ts written before scripts/smoke.ts.`

---

## Spec Coverage Map

Every §2 goal and §7 acceptance criterion → covering task(s). (§7 criteria are keyed by their goal ids.)

| Goal / AC | Covering tasks |
|---|---|
| **G1** — OAuthProvider default export; `/mcp` + `/api` reject without bearer; constant `/healthz`; well-knowns | T27 (healthz constant/no-oracle), T31 (default export, well-knowns, unauthenticated rejection, both surfaces) |
| **G2** — consent dance, CSRF-before-passphrase, foreign-resource rejection, props content + no secret, SHA-256-then-constant-time, RateLimiter 5/IP + 20 global + concurrency + window expiry + CF-Connecting-IP, read-only token rejected by write paths | T6 (compare), T7 (scope gate), T28 (all RateLimiter budgets/concurrency/expiry), T29 (CSRF binding + display + redirect/resource validation), T30 (ordered gate chain, props, IP source, wrong-passphrase), T31 (token accepted by both surfaces), T32 (integration CSRF/foreign-resource/429/read-only/no-secret) |
| **G3** — get_quote reusable/no-write; execute_swap terminal payload; drift both branches; approval_required; timeout stays submitted + `timed_out`, no fifth status; revert distinct; list/get; pagination + tampered cursor | T8 (no fifth status in schema), T10/T11 (cursor + pagination), T12 (drift math both branches), T16 (get_quote form/no-write), T17 (drift/approval/terminal payload), T19 (workers-pool abort proofs), T20 (timeout vs revert, deadline bound), T22 (read tools + pagination + tamper), T23 (execute_swap payload + floor forwarding) |
| **G4** — REST mirror payload/scope parity, expectedAmountOut, timed_out passthrough, props-adapter, pagination | T25 (props adapter + status mapping), T26 (all four routes incl. read-only rejection, floor, timeout, pagination), T32 (integration write-path rejection) |
| **G5** — EXACT_INPUT/CLASSIC/string chain ids/sentinel; routing assertion + routing-aware accessor; spread `/swap` + null-permit strip; 8s timeout; retry policy; direction-aware balances + gas headroom; receipt success vs revert; address-constants test | T9 (constants), T13 (shapes/assertion/accessor/spread/sentinel), T14 (timeout/retry/never-`/swap`), T15 (balances, receipt outcomes), T17 (gas headroom in orchestration) |
| **G6** — slippage cap/default, amount>0, insufficient_balance direction/gas-aware, deadline default, caller-floor abort pre-submission, approval_required pre-submission | T12 (pure rails), T17 (orchestrated rails + aborts), T19 (workers-pool proof) |
| **G7** — concurrent execute_swap serialized by in-DO promise-chain mutex; no overlapping submit; nonce order | T21 (dedicated concurrency test), T15/T20 (receipt disambiguation feeding G7's row) |
| **G8** — one row per attempt; pending→submitted→confirmed; revert → failed/swap_failed + txHash; aborts → failed + errorCode + no txHash; timeout leaves submitted + txHash; lifecycle columns | T8 (schema/columns), T11 (transitions/dispositions), T17 (service-level), T18 (happy lifecycle in D1), T19 (abort dispositions in D1), T20 (timeout/revert rows) |
| **G9** — mid-swap `submitted` visible before execute_swap returns; live reads | T18 (eager-write proof), T21 (dedicated interleaving test), T22/T26 (live get paths) |
| **G10** — closed allowlist (`quote_expired` absent, `approval_required` present); no raw messages; log/envelope leak tests | T3 (allowlist/classify/envelope), T4 (redaction + leak tests), T22/T23 (envelope-only tool errors), T25/T26 (HTTP mapping), T32 (integration leak test) |
| **G11** — `pnpm test` with zero network; `pnpm typecheck` clean; smoke exists, manual-only | every task's gate; global mocking constraint; T34 (smoke presence + suite exclusion) |
| **G12** — placeholder-only bindings, `nodejs_compat` uncommented, cf-typegen succeeds; fail-closed env | T2 (wrangler + typegen + canary), T5 (validateEnv), T18/T24/T28 (DO bindings kept placeholder, typegen re-run) |
| **G13** — one doc per quadrant; one-time-approval how-to; named runbook incl. pending-row note | T33 (six named files + content assertions), T34 (smoke documented) |

**§6 ordering compliance:** T3–T7 (cross-cutting) → T8–T12 (schema/repository/constants/pure rails) → T13–T17 (engine + swapService incl. balance rail, which first appears with the ViemSigner seam per M7) → T18–T21 (coordinator incl. both drift branches, approval, gas headroom, timeout/revert, disposition, concurrency) → T22–T27 (MCP tools, REST, props middleware, healthz) → T28–T32 (RateLimiter, CSRF, consent, provider wiring, integration) → T33–T34 (docs, smoke). Dependencies always precede consumers; integration breadth strictly increases.

**Self-review checklist (executed):** (1) spec coverage — every G1–G13 AC row above maps to ≥1 assertion bullet; no gaps found after adding the T20 deadline-bound assertion and T32 leak test. (2) Placeholder scan — no TBD/TODO/"fill in"/"similar to Task N" present; every "reject/handle" claim carries a named assertion. (3) Type consistency — `ErrorCode` (T3), `AuthProps`/`SINGLE_USER_ID` (T7), `TransactionsRepository` (T11), `ExecuteSwapInput` (T12), `TradingApiClient`/`ClassicQuoteResponse` (T13), `ViemSigner`/`ReceiptOutcome` (T15), `SwapResult` (T17), `ToolDeps` (T22), `errorCodeToHttpStatus` (T25) are declared before every later use. (4) Dependency order verified (no forward references). (5) Granularity — one green commit per task; red-green inside each task. (6) Test-first — every task's Step 1 is a failing test with a stated failure mode; T19/T32 (pure integration-breadth tests over existing behavior) use the deliberate-inversion red check and say so. (7) Traceability — every assertion bullet cites a §7 goal id or is marked scaffolding.
