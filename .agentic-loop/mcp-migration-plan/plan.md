# swap-mcp Implementation Plan

**Issue:** none — local-only run (no GitHub issue; user adds a remote and opens the PR at Stage 4, spec §8 decision 3)
**Branch:** feat/mcp-migration-plan
**Goal:** Build the full swap-mcp service — an OAuth-guarded MCP + REST swap application on Cloudflare Workers that swaps ETH↔USDC on Ethereum mainnet via the Uniswap Trading API + viem, with a custodial hot wallet and full D1 lifecycle tracking — into the fresh Hono/Workers scaffold, strictly test-first.
**Architecture:** The Worker's default export is a `@cloudflare/workers-oauth-provider` `OAuthProvider` guarding two `apiHandlers` — `/mcp` (the `SwapMcpAgent` streamable-HTTP McpAgent DO) and `/api` (a Hono REST app) — while its public `defaultHandler` serves `/healthz`, the `/authorize` consent screen, and OAuth well-knowns. Both guarded surfaces are thin ingress over a pure `services/` layer; all state-changing swaps are funnelled through the `SwapCoordinator` Durable Object, which serializes execution with an in-DO promise-chain single-flight mutex and eagerly writes every lifecycle transition to D1 (the single source of truth for live reads) via Drizzle. Passphrase consent is CSRF-protected and rate-limited by a strongly-consistent `RateLimiter` Durable Object. The chain sits behind two injectable seams (`TradingApiClient`, `ViemSigner`) and is fully mocked in every automated test; `scripts/smoke.ts` is the only real-chain artifact.
**Tech stack:** hono (existing scaffold), `agents@^0.17.3`, `@modelcontextprotocol/sdk`, `@cloudflare/workers-oauth-provider@^0.8.1`, `zod@^4`, `drizzle-orm@^0.45.2`, `viem@^2.55.0`; dev: `wrangler` (existing), `vitest@^4.1.10`, `@cloudflare/vitest-pool-workers@^0.18.4`, `drizzle-kit@^0.31.10`, `tsx`, `prettier`. Package manager: **pnpm only** (pinned in `package.json`).

---

## Global constraints (apply to every task; not repeated per task)

- **No AI-attribution commit trailers.** Every commit message is conventional-commit style with a `TDD:` body line naming the test written before the implementation. **No `Co-Authored-By:` or any AI-attribution trailer on any commit** (spec §8, decision 13).
- **TDD Iron Law.** One task = one green commit. Red-green-refactor happens *inside* a task: write the failing test → run it and confirm the stated red → write minimal implementation → run and confirm green → run the full gate → commit. A task never commits a red test without its implementation.
- **Global test gate.** The repo's resolved quality gate is `pnpm typecheck && pnpm vitest run` (there is no `scripts/quality-gates.sh` in this repo). "Run full gate" in any task step means exactly that command pair, and every task must end with it green.
- **Fully mocked chain.** No automated test may hit the network or a real RPC. Chain I/O is exercised only through injected fake `TradingApiClient` / `ViemSigner` implementations returning recorded fixtures from `test/fixtures/`. `scripts/smoke.ts` (T34) is the only real-chain artifact and is never run by the suite.
- **Placeholder bindings/secrets.** All bindings ship as placeholders (`OAUTH_KV`, D1 id, three DO bindings) and all secrets (`SWAP_PRIVATE_KEY`, `AUTH_PASSPHRASE`, `UNISWAP_API_KEY`, `ETH_RPC_URL`) are documented `wrangler secret put` placeholders, never committed (spec §5.1, G12).
- **cf-typegen output committed.** Every task that runs `pnpm cf-typegen` (T2, T18, T24, T28) must commit the **regenerated `worker-configuration.d.ts`** (the `CloudflareBindings` type file) in the same green commit, so the committed types always match the committed `wrangler.jsonc` bindings.
- **Vitest layout (research-stage2 — overrides any older API memory).** `vitest.config.ts` uses the `cloudflareTest()` Vite plugin from `@cloudflare/vitest-pool-workers` inside plain `defineConfig` from `vitest/config` — never `defineWorkersConfig`, never `poolOptions.workers`, never `isolatedStorage`/`singleWorker` (per-file isolation is the default). Worker-level fetches use `import { env, exports } from "cloudflare:workers"` and `exports.default.fetch()` — never `SELF`. DO instance access uses `runInDurableObject` from `cloudflare:test`. D1 migrations reach tests via `readD1Migrations("./drizzle")` → `miniflare.bindings.TEST_MIGRATIONS` → `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` in a setup file.

## Resolved planning choices (latitude exercised by the planner)

Three points where the spec permitted implementer latitude; the plan records the chosen resolution so tasks are unambiguous:

1. **Scope grant = unconditionally both `["swap:read","swap:write"]` (interview decision 26, round 7).** The consent POST (T30) hardcodes the grant exactly as spec §5.6 states — `completeAuthorization` is always called with both scopes regardless of what the client requested. An earlier draft's requested-∩-both intersection was rejected at plan review as an unauthorised access-control change. **The production consent flow always grants both scopes; there is no token-forging seam and none may be created** (`@cloudflare/workers-oauth-provider` end-to-end-encrypts grant props under the access token, so no forged read-only bearer is decryptable). T32's write-path rejection coverage is therefore proven at the **app-owned auth seam** in the workers pool — a fake `deps.getProps` returning `{ scopes: ["swap:read"] }` is asserted to make `requireScope(props,"swap:write")` reject against both the real `registerExecuteSwap` registrar and the real `POST /api/swap` route (via the T25 props-adapter seam) — never by minting a narrower token.
2. **Cursor integrity = strict schema validation (not HMAC).** Spec §5.7 permits "HMAC-signed **or** strictly schema-validated". The cursor codec (T10) base64url-encodes canonical JSON and strictly Zod-validates `{ createdAt: positive int, id: uuid }` on decode; any tamper producing an out-of-schema payload is rejected `invalid_input`. A structurally-valid-but-different cursor merely addresses a different page and leaks nothing — no server signing secret is introduced.
3. **Incremental DO bindings in `wrangler.jsonc`.** The three DO classes are wired into `wrangler.jsonc` (`durable_objects.bindings` + `migrations.new_sqlite_classes`) incrementally as each class first comes into existence — `SwapCoordinator` (T18), `SwapMcpAgent` (T24), `RateLimiter` (T28) — because the pool fails to boot if the config names a class the Worker does not yet export. The final config state matches spec §5.1 exactly.

---

## File Structure

Test tree: `test/node/**` (node pool — pure logic), `test/workers/**` (workers pool — DO/runtime), `test/integration/**` (workers pool, full-worker `exports.default.fetch()`), `test/fixtures/**` (recorded Trading API / receipt fixtures), `test/helpers/**` (production OAuth-dance token helper), `test/setup/**` (migration setup file).

**Source & config**

- Modify `package.json` — runtime + dev deps; scripts `test`, `typecheck`, `lint`, `format`, `db:generate`, `smoke` (existing `dev`/`deploy`/`cf-typegen` unchanged) *(T1)*
- Create `vitest.config.ts` — three projects: node (T1), workers (T2), integration (T31); D1 migration wiring added in T8 *(T1, +T2/T8/T31)*
- Modify `wrangler.jsonc` — `nodejs_compat`, vars, `OAUTH_KV`, `DB` (D1); three DO bindings + `new_sqlite_classes` built up incrementally *(T2, +T18/T24/T28)*
- Create `src/errors.ts` — closed `ErrorCode` allowlist, `AppError`, `classify`, `toErrorEnvelope` (envelope redaction added T4) *(T3, +T4)*
- Create `src/log.ts` — `redact` (secret-name + long-hex scrub) + structured `log` *(T4)*
- Create `src/env.ts` — `validateEnv`, `ValidatedEnv` with secret-accessor functions, `TRADING_API_BASE_URL` host allowlist *(T5)*
- Create `src/auth/constantTime.ts` — SHA-256-then-constant-time digest compare *(T6)*
- Create `src/auth/guards.ts` — `transportGuard`, `assertAudience`, `requireScope`, `AuthProps`, `SINGLE_USER_ID` *(T7)*
- Create `src/db/schema.ts` — `swaps` table (Drizzle) *(T8)*
- Create `drizzle.config.ts` + `drizzle/*` — drizzle-kit config + generated SQL migrations *(T8)*
- Create `test/setup/apply-migrations.ts` — `applyD1Migrations` setup file *(T8)*
- Create `src/engine/constants.ts` — mainnet address constants + native-ETH zero sentinel *(T9)*
- Create `src/repository/cursor.ts` — opaque strictly-schema-validated `(createdAt, id)` cursor codec *(T10)*
- Create `src/repository/transactions.ts` — Drizzle repository incl. lifecycle transitions + cursor pagination *(T11)*
- Create `src/services/rails.ts` — pure safety rails, drift math, slippage percent↔fraction *(T12)*
- Create `src/engine/tradingApiClient.ts` — `TradingApiClient` interface + fetch-backed factory, routing-shape assertion (T13), 8s timeout + jittered retry (T14) *(T13, +T14)*
- Create `src/engine/viemSigner.ts` — `ViemSigner` interface + viem-backed factory, direction-aware balances, receipt disambiguation *(T15)*
- Create `src/services/swapService.ts` — `getQuote` (T16) / `executeSwap` (T17) orchestration behind deps; receipt disambiguation branch (T20) *(T16, +T17/T20)*
- Create `src/coordinator/SwapCoordinator.ts` — DO: lifecycle writes (T18), receipt branch (T20), promise-chain mutex (T21) *(T18, +T20/T21)*
- Create `src/mcp/tools/deps.ts` — shared `ToolDeps` type *(T22)*
- Create `src/mcp/tools/getQuote.ts`, `src/mcp/tools/getTransaction.ts`, `src/mcp/tools/listTransactions.ts` — read-tool registrars *(T22)*
- Create `src/mcp/tools/executeSwap.ts` — write-tool registrar *(T23)*
- Create `src/mcp/SwapMcpAgent.ts` — McpAgent DO wiring the four registrars *(T24)*
- Create `src/api/middleware/props.ts` — props-adapter middleware + `errorCodeToHttpStatus` + `errorResponse` *(T25)*
- Create `src/api/apiApp.ts`, `src/api/routes/quote.ts`, `src/api/routes/swap.ts`, `src/api/routes/transactions.ts` — REST mirror app + routes *(T26)*
- Create `src/oauth/publicApp.ts` — `/healthz` (T27), `GET /authorize` (T29), `POST /authorize` (T30) *(T27, +T29/T30)*
- Create `src/oauth/csrf.ts` — single-use OAUTH_KV-nonce CSRF token bound to the AuthRequest *(T29)*
- Create `src/ratelimit/RateLimiter.ts` — strongly-consistent rate-limit DO *(T28)*
- Modify `src/index.ts` — default export `new OAuthProvider(...)`, re-export the three DO classes (scaffold Hello-Hono replaced) *(T31; DO classes progressively re-exported at T18/T24/T28)*

**Docs & scripts**

- Create `docs/tutorials/getting-started.md` — stand up locally, mint a token, run a mocked quote *(T33)*
- Create `docs/how-to/configure-secrets-and-deploy.md` — set secrets/ids, deploy, run smoke *(T33; linked from T34)*
- Create `docs/how-to/one-time-usdc-approval.md` — one-time USDC→Universal Router `approve` out-of-band *(T33)*
- Create `docs/how-to/reconcile-stranded-submitted.md` — named reconciliation runbook for `submitted`-stranded swaps *(T33)*
- Create `docs/reference/api-and-data-model.md` — MCP/REST schemas, `swaps` columns + lifecycle, error allowlist *(T33)*
- Create `docs/explanation/architecture-decisions.md` — design-decision explanation *(T33)*
- Create `scripts/smoke.ts` — manual real-chain smoke script (tsx) *(T34)*

**Test files** (one per task, named in each task below).

> **No double-create conflict.** Every file above is *created* by exactly one task; all subsequent touches are *modifications*. `vitest.config.ts`, `wrangler.jsonc`, `src/index.ts`, `src/services/swapService.ts`, `src/coordinator/SwapCoordinator.ts`, `src/engine/tradingApiClient.ts`, and `src/oauth/publicApp.ts` are each created once and modified by later tasks by design (spec-sanctioned incremental build-up). `test/workers/scope-seam.test.ts` is created once by T32 (the decision-26 read-only-token seam test).

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

- `package.json` dependencies: `agents@^0.17.3`, `@modelcontextprotocol/sdk@^1.26` (pin `^1.26` — versions <1.26 share a single `McpServer` across requests, a cross-client leakage hazard), `@cloudflare/workers-oauth-provider@^0.8.1`, `zod@^4`, `drizzle-orm@^0.45.2`, `viem@^2.55.0` (keep existing `hono`)
- `package.json` devDependencies: `@cloudflare/vitest-pool-workers@^0.18.4` (pin whatever patch exports `cloudflareTest()` with the vitest ^4.1 peer at install time), `vitest@^4.1.10`, `drizzle-kit@^0.31.10`, `tsx`, `prettier` (keep existing `wrangler`)
- `package.json` scripts: `test: "vitest run"`, `typecheck: "tsc --noEmit"`, `lint: "prettier --check ."`, `format: "prettier --write ."`, `db:generate: "drizzle-kit generate"`, `smoke: "tsx scripts/smoke.ts"` (existing `dev`/`deploy`/`cf-typegen` unchanged; pnpm only)
- `vitest.config.ts`: `defineConfig` from `vitest/config` with `test.projects` containing one project `{ test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node" } }`

**Expected pass criteria:** `pnpm install` succeeds with a single pnpm lockfile; canary green; `pnpm typecheck` exits 0.

- [ ] **Step 1:** Run `pnpm vitest run` before adding anything — confirm it fails (no config/tests).
- [ ] **Step 2:** Add deps/devDeps/scripts to `package.json`; `pnpm install`.
- [ ] **Step 3 (install-time verification, research-stage2 §Planning implications #4):** Inspect `node_modules/agents/dist/mcp.d.ts` and confirm the static `serve(path, options?)` overload exists and note whether `options.binding` is present. Record the finding as a code comment where `SwapMcpAgent.serve("/mcp")` will be called (T31). **Pass/fail oracle:** *pass* = a `serve(path, options?)` overload exists whose `options` is optional (or absent) → T31 calls `SwapMcpAgent.serve("/mcp")` with no second argument, matching spec §5.6/M8. *Fail-branch* = if the **only** available overload requires a `{ binding }` argument, this does **not** block — T31 instead passes `{ binding: "SwapMcpAgent" }` (the class-name binding added in T24), and the code comment records which form the installed types dictated. Either way the finding is pinned in a comment; the plan's default assumption is the no-`{ binding }` form.
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
  - `env.OAUTH_KV` is defined (covers §7 G12 placeholder-bindings; scaffolding for G1/G2 — the `OAUTH_KV` name is load-bearing: `@cloudflare/workers-oauth-provider@0.8.1` reads `env.OAUTH_KV` by convention, there is no `kv` constructor option)
  - `env.DB` is defined and `env.DB.prepare("SELECT 1").first()` resolves (`SELECT 1` is **deliberately schema-free** — it proves the D1 binding is live without depending on any table, since migrations are not applied until T8; covers §7 G12; scaffolding for G8)
  - `env.CHAIN_ID === "1"`, `env.CANONICAL_MCP_URI`, `env.TRADING_API_BASE_URL`, `env.ALLOWED_ORIGINS` are defined (covers §7 G12)

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
  - `classify(new AppError("slippage_exceeded"))` returns `"slippage_exceeded"`; `classify(new Error("boom"))` and `classify("junk")` return `"internal"` (covers §7 G10)
  - `toErrorEnvelope("invalid_input", "bad amount")` returns `{ content: [{ type: "text", text: <string> }], structuredContent: { error: { code: "invalid_input", message: "bad amount" } }, isError: true }` (covers §7 G10)
  - the envelope `message` never contains the raw `.message` of a classified internal error — `toErrorEnvelope(classify(new Error("secret-detail")), CURATED[code])` contains no `"secret-detail"` (covers §7 G10: raw upstream/internal messages never reflected)

**Expected first-run failure:** `Cannot find module '../../src/errors'` / `AppError is not a constructor`.

**Implementation surface:**

- `export const ERROR_CODES = [...] as const; export type ErrorCode = (typeof ERROR_CODES)[number]`
- `export class AppError extends Error { readonly code: ErrorCode; constructor(code: ErrorCode, publicMessage?: string) }`
- `export function classify(err: unknown): ErrorCode`
- `export function toErrorEnvelope(code: ErrorCode, publicMessage: string): ErrorEnvelope` (type exported)

**Expected pass criteria:** all assertions green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `src/errors.ts` minimally.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(errors): closed ErrorCode allowlist with classify and envelope`. Body: `TDD: test/node/errors.test.ts written before src/errors.ts.`

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
  - a spy on `console.log` shows `log("info", { privateKey: "x" })` serialized JSON containing `"[redacted]"` and never `"x"` — redaction is applied inside `log`, not by caller convention (covers §7 G10)
  - `toErrorEnvelope("internal", "leak 0x" + "ab".repeat(40)).structuredContent.error.message` contains no long hex (covers §7 G10: envelope redaction enforced)

**Expected first-run failure:** `Cannot find module '../../src/log'`.

**Implementation surface:**

- `export function redact(fields: Record<string, unknown>): Record<string, unknown>` (recursive; secret-name key patterns + long-hex scrubber)
- `export function log(level: "info" | "warn" | "error", fields: Record<string, unknown>): void`
- `src/errors.ts`: `toErrorEnvelope` passes `publicMessage` through the long-hex/secret scrub from `redact` before embedding

**Expected pass criteria:** all four tests green; T3 tests still green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `src/log.ts`; wire `toErrorEnvelope` through `redact`.
- [ ] **Step 4:** Run test, confirm green (and T3 still green).
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(log): structured logger with enforced redaction shared by error envelopes`. Body: `TDD: test/node/log.test.ts written before src/log.ts.`

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
  - `CHAIN_ID: "5"` throws (covers §7 G12 / non-goal single-chain)
  - `TRADING_API_BASE_URL: "https://evil.example/v1"` throws; `"https://trade-api.gateway.uniswap.org/v1"` passes (covers §5.2 host allowlist — G12/G10)
  - `JSON.stringify(validatedEnv)` and `Object.values(validatedEnv)` contain none of the four secret values; `validatedEnv.getSwapPrivateKey()` returns the secret lazily (covers §7 G10/G12 secret-accessor shape)
  - `validatedEnv.allowedOrigins` is the parsed array from the comma-separated `ALLOWED_ORIGINS` var (scaffolding for §5.6 Origin allowlist)

**Expected first-run failure:** `Cannot find module '../../src/env'`.

**Implementation surface:**

- `export interface ValidatedEnv { chainId: "1"; canonicalMcpUri: string; tradingApiBaseUrl: string; allowedOrigins: string[]; getSwapPrivateKey(): string; getAuthPassphrase(): string; getUniswapApiKey(): string; getEthRpcUrl(): string }`
- `export function validateEnv(env: CloudflareBindings): ValidatedEnv` (Zod v4 schema; throws `AppError("internal", ...)` on failure; secrets captured only inside accessor closures)

**Expected pass criteria:** all green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `src/env.ts` (Zod schema + accessor closures + host allowlist).
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(env): fail-closed Zod env validation with secret accessors and host allowlist`. Body: `TDD: test/node/env.test.ts written before src/env.ts.`

---

### Task 6: Constant-time passphrase compare (M10)

**Domain:** general-purpose
**Files:**

- Create: `src/auth/constantTime.ts`
- Test: `test/workers/constant-time.test.ts` (workers pool, not node — `crypto.subtle.timingSafeEqual` is a Workers-runtime extension absent from Node's WebCrypto)

**Test contract:**

- File: `test/workers/constant-time.test.ts`
- Test names: `equal strings compare true`, `unequal strings compare false`, `length difference compares false without throwing`, `comparison operates on SHA-256 digests`
- Assertions:
  - `await timingSafeEqualDigest("secret", "secret")` is `true` (covers §7 G2 SHA-256-then-constant-time)
  - `await timingSafeEqualDigest("secret", "secreT")` and `("secret", "sec")` are `false`, no throw (covers §7 G2 — digesting normalizes length)
  - the implementation digests both inputs with SHA-256 before comparing: assert via an injected/spied `digest` seam (e.g. `timingSafeEqualDigest(a, b, { digest })` records two SHA-256 calls) (covers §7 G2)

**Expected first-run failure:** `Cannot find module '../../src/auth/constantTime'`.

**Implementation surface:**

- `export async function timingSafeEqualDigest(a: string, b: string, deps?: { digest?: (data: Uint8Array) => Promise<ArrayBuffer> }): Promise<boolean>` — SHA-256 both sides via `crypto.subtle.digest`, then compare the two 32-byte digests with **`crypto.subtle.timingSafeEqual`** (the Workers-runtime constant-time primitive) — never a raw string compare and never a hand-rolled byte loop

**Expected pass criteria:** green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `src/auth/constantTime.ts`.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(auth): SHA-256 digest constant-time passphrase compare`. Body: `TDD: test/workers/constant-time.test.ts written before src/auth/constantTime.ts.`

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

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `src/auth/guards.ts`.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(auth): transport, audience and scope guards`. Body: `TDD: test/node/guards.test.ts written before src/auth/guards.ts.`

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
  - `drizzle(env.DB, { schema })` inserts a row with `status: "pending"` and reads it back with identical values, nullable columns null (covers §7 G8)
  - inserting `status: "timed_out"` is rejected (CHECK constraint / enum) — **no fifth status** (covers §7 G3/G8 no-fifth-status)

**Expected first-run failure:** `no such table: swaps` (migrations dir empty / schema module missing).

**Implementation surface:**

- `src/db/schema.ts`: `export const swaps = sqliteTable("swaps", ...)` per §5.11 (uuid PK `id`; `direction` in `("ETH_TO_USDC","USDC_TO_ETH")`; `status` CHECK-constrained to `("pending","submitted","confirmed","failed")`; amounts as text base-unit strings; timestamps as integer epoch-ms)
- `drizzle.config.ts`: `defineConfig({ dialect: "sqlite", schema: "./src/db/schema.ts", out: "./drizzle" })` (no `d1-http` credentials — placeholders only; local/CI path is file-based per research-stage2)
- run `pnpm db:generate` to emit `drizzle/*.sql`
- `test/setup/apply-migrations.ts`: `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` (import from `cloudflare:test`)

**Expected pass criteria:** schema tests green with per-file-isolated D1; T2 canary still green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm `no such table` failure.
- [ ] **Step 3a (export-path verification):** before writing the vitest config, confirm `readD1Migrations` is actually exported by the installed `@cloudflare/vitest-pool-workers` package — inspect its `package.json` `exports` / the `.d.ts` for the exact import path (`@cloudflare/vitest-pool-workers/config` vs another subpath). Pin the verified path in a code comment; do not assume.
- [ ] **Step 3:** Implement schema + config, generate migrations, wire `TEST_MIGRATIONS` + setup file (import `readD1Migrations` from the verified path).
- [ ] **Step 4:** Run test, confirm green (T2 canary still green).
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(db): swaps schema with drizzle-kit migrations applied in tests`. Body: `TDD: test/workers/schema.test.ts written before src/db/schema.ts.`

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

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `src/engine/constants.ts`.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(engine): pinned mainnet address constants with checksummed assertions`. Body: `TDD: test/node/constants.test.ts written before src/engine/constants.ts.`

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
  - flipping one character of an encoded cursor makes `decodeCursor` throw `AppError("invalid_input")` (covers §7 G3/G4 tampered-cursor rejection — spec §5.7 permits "strictly schema-validated" in place of HMAC, chosen in Resolved planning choice 2; this codec strictly Zod-validates the base64url JSON payload `{ createdAt: positive int, id: uuid }` so any tamper producing an out-of-schema payload is rejected; structurally-valid-but-different cursors merely address a different page and leak nothing)
  - `decodeCursor("not-base64!!")` throws `AppError("invalid_input")` (covers §7 G3/G4)

**Expected first-run failure:** `Cannot find module '../../src/repository/cursor'`.

**Implementation surface:**

- `export type CursorPayload = { createdAt: number; id: string }`
- `export function encodeCursor(p: CursorPayload): string` (base64url of canonical JSON)
- `export function decodeCursor(cursor: string): CursorPayload` (strict Zod parse; throws `AppError("invalid_input")`)

**Expected pass criteria:** green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `src/repository/cursor.ts`.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(repository): opaque strictly-validated pagination cursor`. Body: `TDD: test/node/cursor.test.ts written before src/repository/cursor.ts.`

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
  - `findById` returns the current row; unknown id returns `undefined` (covers §7 G9)
  - seeding 25 rows: `list({})` returns 20 rows ordered by `(createdAt, id)` desc + non-null `nextCursor`; passing `nextCursor` back returns the remaining 5 with `nextCursor: null`; `list({ limit: 500 })` returns ≤100 (covers §7 G3 pagination defaults/caps/stable nextCursor)
  - `list({ cursor: tampered })` throws `AppError("invalid_input")` (covers §7 G3)
  - `list({ status: "failed" })` returns only failed rows (covers §5.7 status filter — G3)

**Expected first-run failure:** `Cannot find module '../../src/repository/transactions'`.

**Implementation surface:**

- `export function createTransactionsRepository(db: DrizzleD1Database<typeof schema>): TransactionsRepository`
- `export interface TransactionsRepository { insertPending(row: NewSwapInput): Promise<string>; markSubmitted(id: string, txHash: string): Promise<void>; markConfirmed(id: string, r: { actualAmountOut: string; gasUsed: string }): Promise<void>; markFailed(id: string, errorCode: ErrorCode, opts?: { txHash?: string }): Promise<void>; findById(id: string): Promise<SwapRow | undefined>; list(q: { limit?: number; cursor?: string; status?: SwapStatus }): Promise<{ rows: SwapRow[]; nextCursor: string | null }> }`

**Expected pass criteria:** green against migrated per-file D1; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `src/repository/transactions.ts` (uses T10 cursor codec).
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(repository): transactions repository with lifecycle transitions and cursor pagination`. Body: `TDD: test/workers/repository.test.ts written before src/repository/transactions.ts.`

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
  - **integer-bps pin (before the bigint multiply):** the drift math converts `slippageTolerancePct` to **integer basis points** (`0.5` → `50n` bps, `5` → `500n` bps) and uses `expected − expected × tolBps / 10000n`; assert the intermediate bps value is an integer bigint (no float enters the bigint amount math — a `0.5%` tolerance is `50n`, never `0.005 × expected` in floating point) (covers §7 G6 integer-bps drift math)
  - caller-floor branch: with `expectedAmountOut = 1000n`, `tol = 0.5`, `checkDrift(994n, 1000n, 0.5)` returns `{ abort: true }` (994 < 1000 × 0.995) and `checkDrift(996n, 1000n, 0.5)` returns `{ abort: false }` (covers §7 G3/G6 drift floor)
  - omitted-floor branch: `checkDrift(anyFresh, undefined, tol)` always returns `{ abort: false }` — no drift abort; the API-embedded slippage floor is the only rail (covers §7 G3/G6 omitted-floor semantics; guards the v2 double-count bug)

**Expected first-run failure:** `Cannot find module '../../src/services/rails'`.

**Implementation surface:**

- `export function resolveSwapParams(input: ExecuteSwapInput): ResolvedSwapParams` (defaults + validation; throws `AppError("invalid_input")`)
- `export function pctToFraction(pct: number): number`
- `export function checkDrift(freshOut: bigint, expectedAmountOut: bigint | undefined, slippageTolerancePct: number): { abort: boolean }` (bigint math: `freshOut < expected − expected × tolBps / 10000n` style — no float on amounts)
- `export type ExecuteSwapInput = { direction: "ETH_TO_USDC" | "USDC_TO_ETH"; amountIn: string; expectedAmountOut?: string; slippageTolerancePct?: number; deadlineSeconds?: number }`

**Expected pass criteria:** green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `src/services/rails.ts`.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(services): pure safety rails with drift-floor math and slippage units`. Body: `TDD: test/node/rails.test.ts written before src/services/rails.ts.`

---

### Task 13: TradingApiClient — request/response shapes + routing assertion

**Domain:** general-purpose
**Files:**

- Create: `src/engine/tradingApiClient.ts`, `test/fixtures/tradingApi.ts` (fixtures: `/check_approval` null + non-null; `/quote` CLASSIC, WRAP, UNWRAP, and a DUTCH_V2-shaped body; `/swap` response — the Trading API nests the tx under a top-level `{ swap: { to, data, value, ... } }` key, so the fixture is nested and the client unwraps it)
- Test: `test/node/trading-api-shapes.test.ts`

**Test contract:**

- File: `test/node/trading-api-shapes.test.ts`
- Test names: `getQuote sends the EXACT_INPUT CLASSIC request contract with pinned tokenIn/tokenOut`, `all calls carry required headers`, `routing-shape assertion fails closed on non-CLASSIC-family routing`, `quoted output is read via the routing-aware accessor`, `buildSwap spreads the quote, strips null permit fields, and unwraps the nested { swap } response`, `native ETH uses the zero-address sentinel`
- Assertions (fetch stubbed via injected `fetchImpl`; fixtures only):
  - `/quote` body has `type:"EXACT_INPUT"`, `tokenInChainId:"1"`, `tokenOutChainId:"1"` (strings), `routingPreference:"CLASSIC"`, `swapper`, base-unit `amount`, `slippageTolerance` as **percent** number, and **pinned `tokenIn`/`tokenOut` addresses** — ETH_TO_USDC sends `tokenIn === NATIVE_ETH_SENTINEL`, `tokenOut === USDC_ADDRESS`; USDC_TO_ETH the reverse (covers §7 G5)
  - every request carries `x-api-key` (via accessor), `Content-Type: application/json`, `x-universal-router-version: 2.0`, and targets `TRADING_API_BASE_URL` (covers §7 G5)
  - a DUTCH_V2-routing fixture makes `getQuote` throw `AppError("upstream_unavailable")` **before** any output field is read (covers §7 G5 routing assertion — fail closed)
  - `readQuotedOutput(classicFixture) === fixture.quote.output.amount` for CLASSIC/WRAP/UNWRAP — accessor is routing-aware, never a bare property read on unasserted shapes (covers §7 G5)
  - `buildSwap` request body is the quote response spread at top level (not nested under `quote`), with `permitData: null` / `permitTransaction: null` keys absent; the `/swap` **response is nested under a top-level `{ swap: {...} }` key and `buildSwap` unwraps it** (assert the client reads `response.swap`, not a top-level `response.to`); result is `{ to, data, value, chainId, gasLimit }` with `to === UNIVERSAL_ROUTER_ADDRESS` (covers §7 G5)
  - ETH-side token in requests is `NATIVE_ETH_SENTINEL` for ETH_TO_USDC input / USDC_TO_ETH output (covers §7 G5)

**Expected first-run failure:** `Cannot find module '../../src/engine/tradingApiClient'`.

**Implementation surface:**

- `export interface TradingApiClient { checkApproval(i: { token: string; amount: string; walletAddress: string }): Promise<{ approval: unknown | null }>; getQuote(i: QuoteInput): Promise<ClassicQuoteResponse>; buildSwap(q: ClassicQuoteResponse): Promise<SwapTx> }`
- `export function createTradingApiClient(deps: { baseUrl: string; getApiKey: () => string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; random?: () => number }): TradingApiClient`
- `export function readQuotedOutput(q: ClassicQuoteResponse): string`
- `export function assertClassicFamilyRouting(q: { routing: string }): asserts q is ClassicQuoteResponse` (throws `AppError("upstream_unavailable")` unless routing ∈ {CLASSIC, WRAP, UNWRAP})
- Types: `QuoteInput`, `ClassicQuoteResponse` (discriminated on `routing`), `SwapTx = { to: string; data: string; value: string; chainId: number; gasLimit: string }`

**Expected pass criteria:** green; gate green.

- [ ] **Step 1:** Write the failing test + fixtures covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `src/engine/tradingApiClient.ts` (request contract, routing assertion, accessor, buildSwap).
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(engine): trading api client request contract with routing-shape assertion`. Body: `TDD: test/node/trading-api-shapes.test.ts written before src/engine/tradingApiClient.ts.`

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
  - after 3 failures (initial + 2 retries) `/quote` throws `AppError("upstream_unavailable")` (covers §7 G5)
  - `/check_approval` retries identically; `/swap` with a 500 fails immediately with exactly 1 fetch call — never retried, no double-submission (covers §7 G5 `/swap` never retries)
  - a 400 on `/quote` fails without retry (covers §7 G5 — only 429/5xx retry)

**Expected first-run failure:** assertion failure — `/quote` currently makes exactly 1 call and surfaces the raw failure (no retry/timeout layer yet).

**Implementation surface:** internal `requestWithPolicy(path, body, { retryable: boolean })` inside `createTradingApiClient` — 8s `AbortSignal.timeout`-style bound via injected timer seam; ≤2 retries with jittered exponential backoff for `/quote` and `/check_approval` only.

**Expected pass criteria:** T13 + T14 green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm the no-retry/no-timeout assertion failure.
- [ ] **Step 3:** Add the timeout + bounded-retry policy layer.
- [ ] **Step 4:** Run test, confirm green (T13 still green).
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(engine): 8s timeout and bounded jittered retries for idempotent trading api calls`. Body: `TDD: test/node/trading-api-retry.test.ts written before the retry layer.`

---

### Task 15: ViemSigner — direction-aware balances, submit, receipt disambiguation

**Domain:** general-purpose
**Files:**

- Create: `src/engine/viemSigner.ts`, `test/fixtures/receipts.ts` (success receipt, reverted receipt, timeout-throw variant)
- Test: `test/node/viem-signer.test.ts`

**Test contract:**

- File: `test/node/viem-signer.test.ts` (viem clients replaced via an injected `clientFactory` returning fakes — no RPC)
- Test names: `getNativeBalance reads native ETH via getBalance`, `getErc20Balance reads USDC balanceOf`, `sendTransaction signs and submits returning the hash`, `waitForReceipt distinguishes success, revert, timeout and a non-timeout throw (unknown)`, `clients are created per call, not at module scope`, `estimateMaxFeePerGas surfaces the fee estimate`
- Assertions:
  - `getNativeBalance(addr)` delegates to the fake public client's `getBalance` and returns its bigint (18-decimals source for ETH→USDC input — covers §7 G5 direction-aware balances)
  - `getErc20Balance(USDC_ADDRESS, addr)` calls `readContract` with `functionName:"balanceOf"` on `USDC_ADDRESS` and returns the bigint (6-decimals source for USDC→ETH input — covers §7 G5)
  - `sendTransaction({ to, data, value })` uses an account derived via `privateKeyToAccount(getPrivateKey())` and returns the fake hash; the private key is obtained through the accessor at call time, never stored on the signer object (covers §7 G5/G10 — `JSON.stringify(signer)` contains no key material)
  - `waitForReceipt(hash, timeoutMs)`: fake receipt `status:"success"` → `{ kind: "success", gasUsed }`; `status:"reverted"` → `{ kind: "reverted" }`; a `WaitForTransactionReceiptTimeoutError`-named throw → `{ kind: "timeout" }`; **any other (non-timeout) throw — an RPC error, a replacement/`TransactionReceiptNotFoundError`, or an unnamed error — → `{ kind: "unknown" }`** — four distinct outcomes, timeout never conflated with revert, and a non-timeout throw never surfaced as `reverted` (covers §7 G3/G7/G8 timeout-vs-revert + Major 2 non-timeout-throw branch; M3)
  - the injected `clientFactory` is invoked on each signer method call (per-request clients — covers §5.8/§5.9 constraint; scaffolding)
  - `estimateMaxFeePerGas()` returns the fake fee-estimate bigint (scaffolding for the M1 gas-headroom rail in T17)

**Expected first-run failure:** `Cannot find module '../../src/engine/viemSigner'`.

**Implementation surface:**

- `export interface ViemSigner { address: string; getNativeBalance(addr: string): Promise<bigint>; getErc20Balance(token: string, addr: string): Promise<bigint>; estimateMaxFeePerGas(): Promise<bigint>; sendTransaction(tx: { to: string; data: string; value: string }): Promise<string>; waitForReceipt(hash: string, timeoutMs: number): Promise<ReceiptOutcome> }`
- `export type ReceiptOutcome = { kind: "success"; gasUsed: bigint } | { kind: "reverted" } | { kind: "timeout" } | { kind: "unknown" }` — the `"unknown"` default is returned for any non-timeout, non-revert throw (RPC error, replacement, receipt-not-found); the coordinator maps it exactly like `"timeout"` (row stays `submitted`, result `timed_out`), never to `failed` (Major 2 / M3)
- `export function createViemSigner(deps: { getPrivateKey: () => string; getRpcUrl: () => string; clientFactory?: ClientFactory }): ViemSigner` (default factory: `createPublicClient`/`createWalletClient` with `chain: mainnet`, `transport: http(getRpcUrl())`, per call; `waitForTransactionReceipt({ hash, timeout })` with timeout in ms — confirmed current viem 2.55 API)

**Expected pass criteria:** green; gate green.

- [ ] **Step 1:** Write the failing test + receipt fixtures covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `src/engine/viemSigner.ts`.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(engine): viem signer with direction-aware balances and receipt disambiguation`. Body: `TDD: test/node/viem-signer.test.ts written before src/engine/viemSigner.ts.`

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
  - `ETH_TO_USDC` maps `tokenIn = NATIVE_ETH_SENTINEL`, `tokenOut = USDC_ADDRESS`; `USDC_TO_ETH` the reverse (covers §7 G5)

**Expected first-run failure:** `Cannot find module '../../src/services/swapService'`.

**Implementation surface:**

- `export type SwapServiceDeps = { tradingApi: TradingApiClient; signer: ViemSigner; repo: TransactionsRepository; now?: () => number }`
- `export async function getQuote(deps: Pick<SwapServiceDeps, "tradingApi" | "now">, input: { direction: Direction; amountIn: string }): Promise<QuoteResult>`
- `export type QuoteResult = { direction: Direction; amountIn: string; quotedAmountOut: string; price: string; slippageTolerancePct: number; createdAt: number; freshUntil: number }`

**Expected pass criteria:** green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `getQuote` in `src/services/swapService.ts`.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(services): quote service with reusable expectedAmountOut output`. Body: `TDD: test/node/swap-service-quote.test.ts written before swapService.getQuote.`

---

### Task 17: swapService.executeSwap orchestration + gas-headroom balance rail

**Domain:** general-purpose
**Files:**

- Modify: `src/services/swapService.ts`
- Test: `test/node/swap-service-execute.test.ts`

**Test contract:**

- File: `test/node/swap-service-execute.test.ts` (fake `TradingApiClient` + fake `ViemSigner` + in-memory fake `TransactionsRepository` recording transitions)
- Test names: `happy path transitions pending→submitted→confirmed`, `re-quote happens immediately before submission and is routing-asserted`, `caller drift floor aborts with slippage_exceeded and no transaction`, `omitted floor never drift-aborts`, `USDC→ETH non-null approval aborts approval_required without any transaction`, `ETH→USDC skips check_approval`, `balance/gas-headroom rail runs after buildSwap and consumes SwapTx.gasLimit`, `ETH→USDC balance rail requires amountIn plus gas headroom`, `USDC→ETH balance rail checks erc20 input and native gas separately`, `rail failures write pending→failed with errorCode and no txHash`
- Assertions:
  - happy path: repo sees `insertPending` → `markSubmitted(txHash)` → `markConfirmed({ actualAmountOut, gasUsed })` in order; result `{ status: "confirmed", result: "ok", txHash, transactionId, actualAmountOut, gasUsed }` (covers §7 G3/G8)
  - `tradingApi.getQuote` is called inside `executeSwap` (never reuses a client quote) with `slippageTolerance` = resolved pct; a DUTCH_V2 re-quote fixture aborts `upstream_unavailable` with the row marked failed (covers §5.8 step 2 / G5)
  - with `expectedAmountOut` supplied and fresh output below `expected × (1 − tol)`: result failed `slippage_exceeded`, repo shows `pending→failed` with `errorCode:"slippage_exceeded"` and no `txHash`, and `signer.sendTransaction` was never called (covers §7 G3/G6/G8)
  - with `expectedAmountOut` omitted and a heavily-drifted fresh quote: **no** drift abort — flow proceeds to `/swap`; the service computes/carries no `amountOutMinimum` field anywhere (assert the `/swap` request equals the spread quote) (covers §7 G3/G6 omitted-floor)
  - USDC_TO_ETH with non-null `/check_approval` fixture: abort `approval_required`, `pending→failed`, no swap tx and **no approval tx** sent (`sendTransaction` never called) (covers §7 G3/G6 approval gating; M4)
  - ETH_TO_USDC: `checkApproval` spy has zero calls (covers §5.8 step 4)
  - **the balance/gas-headroom rail runs AFTER `buildSwap` and consumes `SwapTx.gasLimit`:** the fake `buildSwap` is called before any balance read (spy call-order assertion), and the rail's shortfall computation uses the `gasLimit` from the `buildSwap` result (not a value invented before it) — matching spec §5.8 v3.2 step order; the rail still fires **before** `sendTransaction` (covers Major 1 — rail sequenced after its only `gasLimit` source)
  - ETH_TO_USDC with `nativeBalance = amountIn` exactly: `insufficient_balance` (needs `amountIn + gasLimit × maxFeePerGas + buffer`); with generous balance it passes (covers §7 G5/G6 gas headroom — M1)
  - USDC_TO_ETH with `erc20Balance < amountIn` → `insufficient_balance`; with sufficient USDC but native balance below `gasLimit × maxFeePerGas` → `insufficient_balance` (covers §7 G5/G6 direction-aware rail — M2)
  - **decimals lock (optional pin):** a `1 ETH` input is `amountIn = "1000000000000000000"` (18 decimals, native) and a `1 USDC` input is `amountIn = "1000000"` (6 decimals) — the base-unit strings the direction-aware balance sources compare against, so an 18-vs-6 decimals confusion fails the test (covers §7 G5 direction-aware decimals)
  - `slippageTolerancePct: 6` and `amountIn: "0"` each produce a failed row with `invalid_input` and no tx (covers §7 G6/G8 rail disposition — M6)

**Expected first-run failure:** `executeSwap is not a function` (module exports only `getQuote`).

**Implementation surface:**

- `export async function executeSwap(deps: SwapServiceDeps, input: ExecuteSwapInput & { userId: string }): Promise<SwapResult>` — implements §5.8 v3.2 steps 1–9 sans mutex (mutex lives in the DO, T21): insert pending → re-quote (assert routing) → drift check (T12 `checkDrift`) → approval gate (USDC→ETH only) → input-shape rails that need no gas figure (amount>0, slippage ≤ 5%, deadline) → `buildSwap` → **balance/gas-headroom rail AFTER `buildSwap`** (it consumes `SwapTx.gasLimit` for `gasLimit × maxFeePerGas`; still before sign/submit; shortfall → `pending→failed` `insufficient_balance`, no tx) → sign/submit → `markSubmitted` → `waitForReceipt(hash, deadlineSeconds × 1000)` → confirm/fail/timeout mapping. **Timeout & non-timeout mapping (M3, spec §5.8 v3.2):** `kind:"timeout"` → row untouched after `submitted`, result `timed_out`; any non-timeout throw that is not a genuine `status:"reverted"` receipt is treated the same (row stays `submitted`, result `timed_out`, never `failed`); only a real revert writes `failed`/`swap_failed` (asserted at DO level in T20 and here at unit level)
- `export type SwapResult = { transactionId: string; status: "confirmed" | "failed" | "submitted"; result: "ok" | "timed_out"; txHash?: string; quotedAmountOut?: string; actualAmountOut?: string; gasUsed?: string; errorCode?: ErrorCode }`

**Expected pass criteria:** all nine tests green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm `executeSwap is not a function`.
- [ ] **Step 3:** Implement `executeSwap` orchestration (spec §5.8 v3.2 steps 1–9, sans mutex; balance/gas-headroom rail placed after `buildSwap`).
- [ ] **Step 4:** Run test, confirm green (T16 still green).
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(services): executeSwap orchestration with drift, approval and balance rails`. Body: `TDD: test/node/swap-service-execute.test.ts written before swapService.executeSwap.`

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
  - **secret-leak channels (Major 5):** with `console.log` spied and a fake signer whose `sendTransaction` throws an error whose message embeds `getRpcUrl()`/private-key text, the coordinator's error handling writes a `failed`/`submitted` row whose **D1 columns contain none of those secret values**, and **every captured `log()` call's serialized output contains no secret values** (redaction applied on the coordinator's error branch, not by caller convention) (covers §7 G10 leak channels — D1 rows + coordinator logs)

**Expected first-run failure:** workers pool boot error / `env.SWAP_COORDINATOR is undefined` before the class + binding exist; after scaffolding the class, `executeSwap is not a function`.

**Implementation surface:**

- `export class SwapCoordinator extends DurableObject<CloudflareBindings> { deps?: SwapServiceDeps; async executeSwap(params: ExecuteSwapInput & { userId: string }): Promise<SwapResult> }` — builds `deps ??= createDefaultDeps(this.env)` (drizzle over `this.env.DB`, `createTradingApiClient`, `createViemSigner` with accessors from `validateEnv(this.env)`); delegates to `swapService.executeSwap`; per-request client creation preserved by the T15 factory design
- `wrangler.jsonc`: `durable_objects.bindings: [{ name: "SWAP_COORDINATOR", class_name: "SwapCoordinator" }]`, `migrations: [{ tag: "v1", new_sqlite_classes: ["SwapCoordinator"] }]`
- **Migrations-tag deploy note (local-boot vs real deploy):** a single `v1` migrations array whose `new_sqlite_classes` grows across T18/T24/T28 is **boot-safe locally only** (the pool re-reads config each run). A **real `wrangler deploy` must never happen mid-build**, and a real deployment needs **one migration tag per class addition** (`v1` SwapCoordinator, `v2` SwapMcpAgent, `v3` RateLimiter) because a deployed environment cannot re-apply an edited tag. T33's deploy how-to documents the per-tag sequence; the automated suite only ever boots locally.

**Expected pass criteria:** green; T2 canary still green; `pnpm cf-typegen` regenerated; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm binding/boot then `executeSwap is not a function` failure.
- [ ] **Step 3:** Implement the DO class + wrangler binding/migration + `src/index.ts` export; run `pnpm cf-typegen`.
- [ ] **Step 4:** Run test, confirm green (T2 canary still green).
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(coordinator): SwapCoordinator durable object with eager D1 lifecycle writes`. Body: `TDD: test/workers/coordinator-lifecycle.test.ts written before src/coordinator/SwapCoordinator.ts.`

---

### Task 19: Coordinator abort paths — drift, approval, rails disposition

**Domain:** general-purpose
**Files:**

- Test: `test/workers/coordinator-aborts.test.ts` (no new implementation expected — this is the workers-pool proof over the real DO + real D1 that T17's node-level behavior holds end-to-end; any divergence found is fixed in `src/coordinator/SwapCoordinator.ts` / `src/services/swapService.ts`)

**Test contract:**

- File: `test/workers/coordinator-aborts.test.ts`
- Test names: `caller drift floor aborts slippage_exceeded writing a failed row with no txHash`, `omitted floor proceeds without drift abort`, `USDC→ETH missing approval aborts approval_required without sending anything`, `gas-headroom shortfall aborts insufficient_balance`, `rail abort leaves exactly one failed row (pending→failed)`, `a forced signer throw carrying secrets leaks nothing to D1 or logs`
- Assertions:
  - each abort path returns the matching `errorCode`, and the D1 row is `status:"failed"`, `errorCode` set, `txHash` null; fake signer's `sendTransaction` spy shows zero calls (covers §7 G3/G6/G8)
  - omitted-floor case reaches `buildSwap` and submits (spy: one `sendTransaction`) (covers §7 G3)
  - exactly one row exists per attempt — the pending row is transitioned, never deleted or duplicated (covers §7 G8 one-row-per-attempt)
  - **secret-leak channels (Major 5):** a fake signer throwing an error whose message embeds `getRpcUrl()`/private-key text drives the coordinator's error branch; the persisted D1 row's every column and **every `console`-spied `log()` call** contain none of those secret values — redaction is enforced on the coordinator's real error path against real D1 (covers §7 G10 leak channels end-to-end)

**Expected first-run failure (coverage-ratchet / regression-pin task — sanctioned exemption from watch-it-fail; this plan is the human authorisation):** if T17/T18 are correct these abort-disposition assertions pass immediately — they are **regression pins** over already-built behavior, **not Iron-Law red**, so do not claim Iron-Law red here. **Step 1 deliberately breaks one expectation first** (e.g. asserts an intentionally-wrong errorCode) to confirm the pin bites (watch it fail for the right reason), then restores it. The new secret-leak-channel assertion may be genuinely red if redaction is missing on the coordinator error path — fix it in `src/coordinator/SwapCoordinator.ts` if so.

**Implementation surface:** none expected; fixes land in existing modules if red.

**Expected pass criteria:** all five green; gate green.

- [ ] **Step 1:** Write the failing test; apply the deliberate-inversion red check (invert one assertion, watch it fail for the right reason, restore).
- [ ] **Step 2:** Confirm the inverted assertion fails as expected; restore it.
- [ ] **Step 3:** Fix any genuine coordinator/service divergence surfaced (none expected).
- [ ] **Step 4:** Run test, confirm all five green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `test(coordinator): workers-pool proof of drift, approval and rail abort dispositions`. Body: `TDD: test/workers/coordinator-aborts.test.ts drives the coordinator against real D1; red verified via deliberate assertion inversion.`

---

### Task 20: Receipt-wait timeout vs revert disambiguation (M3)

**Domain:** general-purpose
**Files:**

- Modify: `src/services/swapService.ts` / `src/coordinator/SwapCoordinator.ts` (whatever the red reveals)
- Test: `test/workers/coordinator-receipt.test.ts`

**Test contract:**

- File: `test/workers/coordinator-receipt.test.ts`
- Test names: `receipt timeout leaves the row submitted with txHash and returns result timed_out`, `revert writes failed with swap_failed keeping txHash`, `a non-timeout throw (unknown) leaves the row submitted with result timed_out`, `timeout is never written as failed`, `receipt wait is bounded by deadlineSeconds`
- Assertions:
  - fake signer `waitForReceipt` → `{ kind: "timeout" }`: call result `{ status: "submitted", result: "timed_out", txHash }`; D1 row remains `status:"submitted"` with `txHash`, `errorCode` null — no fifth status value anywhere (covers §7 G3/G8)
  - fake `{ kind: "reverted" }`: result `{ status: "failed" , errorCode: "swap_failed", txHash }`; D1 row `failed` **with** `txHash` retained (unlike pre-submit aborts) (covers §7 G3/G8 revert distinct from timeout)
  - **fake `{ kind: "unknown" }` (non-timeout throw — RPC error / replacement / receipt-not-found):** call result `{ status: "submitted", result: "timed_out", txHash }`; D1 row stays `status:"submitted"` with `txHash`, `errorCode` null — a non-timeout throw is **never** written `failed`/`swap_failed` (that is reserved for a genuine `status:"reverted"` receipt) (covers Major 2 / spec §5.8 v3.2 M3 default branch — G3/G8)
  - after the timeout case, re-reading the row later still shows `submitted` (nothing downgraded it to failed) (covers §7 G3 timeout-never-failed)
  - the fake signer records `timeoutMs === deadlineSeconds × 1000` (default 1200s) (covers §7 G3/G4 receipt bound; decision 19)

**Expected first-run failure:** timeout case red if any conflation exists (e.g. result mapped to `failed`); otherwise apply the deliberate-inversion red check as in T19.

**Implementation surface:** branch in `executeSwap` on `ReceiptOutcome.kind` exactly as typed in T15 (`success`/`reverted`/`timeout`/`unknown`) — no new symbols; `timeout` and `unknown` share the stays-`submitted`/`timed_out` mapping, only `reverted` writes `failed`.

**Sequencing note:** T20 modifies `src/coordinator/SwapCoordinator.ts` / `src/services/swapService.ts` (shared with T18) and must run **after T18**; T21 then runs **after T20** (both share the coordinator file — see T21's sequencing note and `tasks.json` `T21.deps`).

**Expected pass criteria:** green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm red (or apply deliberate-inversion if already green).
- [ ] **Step 3:** Add/confirm the `ReceiptOutcome.kind` branch in `executeSwap`/coordinator.
- [ ] **Step 4:** Run test, confirm green (T18/T19 still green).
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(coordinator): disambiguate receipt timeout from revert with bounded wait`. Body: `TDD: test/workers/coordinator-receipt.test.ts written before the disambiguation branch was finalized.`

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
- **Mutex-eviction note (do not overstate in docs):** the `#tail` mutex is an **in-memory, per-live-instance** primitive — it serializes only within one running DO instance and **does not survive DO eviction/hibernation**. Cross-eviction safety rests on the single-in-flight-swap invariant (one wallet) + D1 reconciliation of any `submitted`-stranded row, **not** on the mutex. Record this bound in a code comment; T33's explanation doc carries the same caveat.

**Sequencing note:** T20 and T21 both modify `src/coordinator/SwapCoordinator.ts` (shared with T18), so they must run **sequentially after T18** — T21 depends on **both T18 and T20** (reflected in `tasks.json` `T21.deps = ["T18","T20"]`) so the receipt-disambiguation branch is in place before the mutex wraps it.

**Expected pass criteria:** all three green; T18–T20 still green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm overlap detected (no mutex yet).
- [ ] **Step 3:** Add the `#tail` promise-chain single-flight mutex.
- [ ] **Step 4:** Run test, confirm green (T18–T20 still green).
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(coordinator): promise-chain single-flight mutex with live mid-swap visibility`. Body: `TDD: test/workers/coordinator-concurrency.test.ts written before the mutex.`

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
  - with `getProps()` returning `resource !== canonicalMcpUri`, `get_quote` returns the `toErrorEnvelope("forbidden", ...)` shape — the per-registrar `assertAudience` wrapper rejects a foreign-audience token before doing work (covers Major 4 — audience gate at registrar)
  - `get_transaction { id }` surfaces the repo row incl. current `status` (covers §7 G3/G9); unknown id → envelope code `not_found` (covers §7 G10)
  - `list_transactions {}` on 25 seeded rows returns 20 + `nextCursor`; `{ cursor: tampered }` → envelope `invalid_input`; `{ limit: 500 }` capped at 100 (covers §7 G3)
  - a thrown fake-repo error surfaces as envelope code `internal` with no raw message text (covers §7 G10)
  - registration uses **`server.registerTool(name, { inputSchema }, handler)`** (the current `@modelcontextprotocol/sdk@^1.26` API), **not** the older `server.tool(...)` overload; the schema passed is a plain object of Zod validators (ZodRawShape), not `z.object(...)` (scaffolding — spec §5.7 Zod v4 requirement + SDK ≥1.26)

**Expected first-run failure:** `Cannot find module '../../src/mcp/tools/getQuote'`.

**Implementation surface:**

- `export type ToolDeps = { getProps: () => AuthProps; canonicalMcpUri: string; service: { getQuote: typeof getQuote }; coordinator: { executeSwap(p: ExecuteSwapInput & { userId: string }): Promise<SwapResult> }; repo: TransactionsRepository }`
- `export function registerGetQuote(server: McpServer, deps: ToolDeps): void`
- `export function registerGetTransaction(server: McpServer, deps: ToolDeps): void`
- `export function registerListTransactions(server: McpServer, deps: ToolDeps): void`
- each handler: `assertAudience(deps.getProps(), deps.canonicalMcpUri)` → `requireScope(deps.getProps(), "swap:read")` → work → `{ content, structuredContent }`; catch-all → `toErrorEnvelope(classify(e), curatedMessage(code))`. `assertAudience` runs as a per-registrar wrapper alongside `requireScope` on **every** tool (Major 4); `ToolDeps` therefore carries `canonicalMcpUri: string`.

**Expected pass criteria:** green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement the three read registrars + `ToolDeps`.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(mcp): read tool registrars with scope gating and error envelopes`. Body: `TDD: test/workers/mcp-read-tools.test.ts written before the registrars.`

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
  - fake coordinator throwing `AppError("insufficient_balance")` → envelope code `insufficient_balance`, no raw message (covers §7 G10)
  - **envelope carries no secret (Major 5):** a fake coordinator throwing an error whose message embeds a private-key/rpc-url string yields a `toErrorEnvelope` whose serialized `content`+`structuredContent` contain **no long-hex run and no secret-name values** — the tool-result envelope is a redacted channel (covers §7 G10 envelope leak channel)

**Expected first-run failure:** `Cannot find module '../../src/mcp/tools/executeSwap'`.

**Implementation surface:** `export function registerExecuteSwap(server: McpServer, deps: ToolDeps): void` (schema: bare raw shape with optional `expectedAmountOut: z.string()`, `slippageTolerancePct: z.number()`, `deadlineSeconds: z.number()`)

**Expected pass criteria:** green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `registerExecuteSwap`.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(mcp): execute_swap tool registrar with write-scope enforcement`. Body: `TDD: test/workers/mcp-execute-tool.test.ts written before the registrar.`

---

### Task 24: SwapMcpAgent class + DO binding

**Domain:** general-purpose
**Files:**

- Create: `src/mcp/SwapMcpAgent.ts`
- Modify: `wrangler.jsonc` (add DO binding `{ name: "SwapMcpAgent", class_name: "SwapMcpAgent" }` — the `agents` McpAgent convention binds by class name for `.serve()`; this deliberately differs from the SCREAMING_SNAKE names of `SWAP_COORDINATOR`/`RATE_LIMITER` and must NOT be "fixed" for consistency, or `.serve()` cannot find its DO; extend the migrations for this class addition — boot-safe locally as a grown `v1` array, but a **real deploy needs its own tag (`v2`) and no `wrangler deploy` mid-build** (see T18's migrations-tag deploy note)), `src/index.ts` (export class), run `pnpm cf-typegen`
- Test: `test/workers/mcp-agent.test.ts`

**Test contract:**

- File: `test/workers/mcp-agent.test.ts`
- Test names: `init registers exactly the four tools`, `getProps is a live thunk over this.props`, `a tool call with a foreign props.resource returns forbidden`, `agent boots as a SQLite-backed DO`
- Assertions:
  - after `init()`, the agent's `server` lists tools exactly `["get_quote","execute_swap","list_transactions","get_transaction"]` (covers §7 G3 tool surface; via `runInDurableObject` or direct instance construction)
  - mutating the props the agent holds between two tool invocations changes what the handler's `getProps()` observes — the thunk is `() => this.props`, never a value captured at init (covers §5.7 live-thunk requirement — G2/G3)
  - **audience wiring:** with `getProps()` returning `props.resource !== CANONICAL_MCP_URI` (e.g. `https://attacker.example/mcp`), any tool call (e.g. `get_quote`) returns the `toErrorEnvelope("forbidden", …)` shape — `assertAudience` is applied as a **per-registrar wrapper alongside `requireScope`**, so a foreign-audience token is rejected on every tool, not only at transport (covers Major 4 — audience wiring in tool dispatch, §5.5(b))
  - the DO binding exists and `env.SwapMcpAgent.idFromName("test")` yields a stub (scaffolding for G1)

**Expected first-run failure:** `Cannot find module '../../src/mcp/SwapMcpAgent'` / missing binding boot error.

**Implementation surface:**

- `export class SwapMcpAgent extends McpAgent<CloudflareBindings, unknown, AuthProps> { server = new McpServer({ name: "swap-mcp", version: "1.0.0" }); async init(): Promise<void> }` — `init()` builds request-invariant deps (validateEnv, drizzle repo, engine clients, coordinator stub factory) and calls the four registrars with `getProps: () => this.props`. **`assertAudience(props, CANONICAL_MCP_URI)` is applied as a per-registrar wrapper alongside `requireScope`** (each handler runs `assertAudience` on `deps.getProps()` before its scope check), so audience is enforced in tool dispatch, not merely at transport (Major 4). The `transportGuard` runs earlier on the agent's fetch path (asserted end-to-end in T31/T32).

**Expected pass criteria:** green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found / boot failure.
- [ ] **Step 3:** Implement the agent + wrangler binding/migration + `src/index.ts` export; run `pnpm cf-typegen`.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(mcp): SwapMcpAgent durable object wiring the four tools`. Body: `TDD: test/workers/mcp-agent.test.ts written before src/mcp/SwapMcpAgent.ts.`

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
  - absent props → HTTP 401 with body `{ error: { code: "unauthorized", message } }` (covers §7 G2/G10)
  - `errorCodeToHttpStatus`: `invalid_input→400, unauthorized→401, forbidden→403, not_found→404, slippage_exceeded→409, insufficient_balance→409, approval_required→409, upstream_unavailable→502, rate_limited→429, swap_failed→502, internal→500` — total over `ERROR_CODES` (covers §5.12/G10; `rate_limited→429` and `approval_required→409` per spec examples)

**Expected first-run failure:** `Cannot find module '../../src/api/middleware/props'`.

**Implementation surface:**

- `export const propsAdapter: MiddlewareHandler` (reads `c.executionCtx.props`, `c.set("props", props)`, 401 envelope when absent)
- `export function errorCodeToHttpStatus(code: ErrorCode): number`
- `export function errorResponse(c: Context, err: unknown): Response` (classify → envelope → status)

**Expected pass criteria:** green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `src/api/middleware/props.ts`.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(api): props adapter middleware and error-to-status mapping`. Body: `TDD: test/workers/api-middleware.test.ts written before src/api/middleware/props.ts.`

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

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `createApiApp` + the four routes.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(api): REST mirror routes with identical scope and payload semantics`. Body: `TDD: test/workers/api-routes.test.ts written before src/api/apiApp.ts.`

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

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found failure.
- [ ] **Step 3:** Implement `src/oauth/publicApp.ts` with the constant-body `/healthz`.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(oauth): public app with constant-body healthz`. Body: `TDD: test/workers/healthz.test.ts written before src/oauth/publicApp.ts.`

---

### Task 28: RateLimiter Durable Object

**Domain:** general-purpose
**Files:**

- Create: `src/ratelimit/RateLimiter.ts`
- Modify: `wrangler.jsonc` (DO binding `RATE_LIMITER` → class `RateLimiter`; extend migrations for this class addition — boot-safe locally as a grown `v1` array, but a **real deploy needs its own tag (`v3`) and no `wrangler deploy` mid-build**, see T18's migrations-tag deploy note), `src/index.ts` (export class), `pnpm cf-typegen`
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

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm binding/boot then method failure.
- [ ] **Step 3:** Implement the DO + wrangler binding/migration + `src/index.ts` export; run `pnpm cf-typegen`.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(ratelimit): strongly consistent RateLimiter durable object`. Body: `TDD: test/workers/rate-limiter.test.ts written before src/ratelimit/RateLimiter.ts.`

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

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm module-not-found / 404 failure.
- [ ] **Step 3:** Implement `src/oauth/csrf.ts` + the consent GET handler.
- [ ] **Step 4:** Run test, confirm green (T27 healthz still green).
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(oauth): hardened consent screen with bound single-use CSRF token`. Body: `TDD: test/workers/consent-get.test.ts written before the consent GET handler.`

---

### Task 30: Consent POST — ordered gate chain + completeAuthorization

**Domain:** general-purpose
**Files:**

- Modify: `src/oauth/publicApp.ts` (add `POST /authorize`)
- Test: `test/workers/consent-post.test.ts`

**Test contract:**

- File: `test/workers/consent-post.test.ts` (fake `OAUTH_PROVIDER` helpers with a spying `completeAuthorization`; real `RateLimiter` DO; real `OAUTH_KV`)
- Test names: `POST with both Origin and Referer absent is rejected before CSRF and passphrase`, `disallowed Origin is rejected`, `invalid or replayed csrf token is rejected before the passphrase is evaluated`, `csrf nonce is consumed on every outcome and a replay is rejected`, `rate limiter is consulted before the passphrase compare and 429s when exhausted`, `correct passphrase completes authorization with exact props`, `wrong passphrase re-renders with error, mints nothing and consumes a failure`, `IP is read only from CF-Connecting-IP`
- Assertions:
  - POST with **both** `Origin` and `Referer` headers absent → rejected (403) **before** CSRF verification and passphrase compare; passphrase-compare spy shows zero invocations (covers §5.6 strict Origin/Referer — the **Origin allowlist is the load-bearing cross-site control**, CSRF token is replay protection not session-binding — G2)
  - POST with Origin outside `allowedOrigins` → 403; passphrase-compare spy shows zero invocations (covers §5.6 Origin allowlist — G2)
  - POST with missing/invalid/replayed CSRF token → rejection; a spy on the passphrase-compare seam proves it was **never called** (covers §7 G2 CSRF-before-passphrase)
  - **the CSRF nonce is consumed on ANY POST outcome** (Origin pass → CSRF-verify path): whether the passphrase later matches or mismatches, the nonce is deleted, so re-submitting the same nonce a second time is **rejected as a replay** (covers §7 G2 single-use nonce — nonce consumed on every outcome, replay rejected)
  - after exhausting the per-IP budget via the real `RateLimiter`, the next POST returns HTTP 429 with envelope code `rate_limited` and the compare spy untouched (covers §7 G2 429-without-evaluating-passphrase)
  - correct passphrase (compared via `timingSafeEqualDigest` — asserted by spying the seam): `completeAuthorization` called once with `props` exactly `{ userId: SINGLE_USER_ID, scopes: ["swap:read","swap:write"], resource: <CANONICAL_MCP_URI> }` — `JSON.stringify(props)` contains no passphrase/key material (covers §7 G2 props content + no-secret + SHA-256-then-constant-time); `recordSuccess` called on the limiter
  - wrong passphrase: re-rendered form with an error message, `completeAuthorization` not called, limiter failure consumed (covers §7 G2 wrong-passphrase path)
  - the IP passed to `checkAndConsume` equals the `CF-Connecting-IP` header even when `X-Forwarded-For` differs (covers §7 G2 IP source)

**Expected first-run failure:** 404 on POST `/authorize`.

**Implementation surface:** `publicApp.post("/authorize", ...)` implementing the strict order: **reject when BOTH `Origin` and `Referer` are absent**, then Origin allowlist (the load-bearing cross-site control) → CSRF verify+consume (nonce deleted on any outcome, so replay is rejected) → resource validation → `env.RATE_LIMITER` `checkAndConsume(CF-Connecting-IP)` → `timingSafeEqualDigest(submitted, getAuthPassphrase())` → on match `completeAuthorization` + `recordSuccess`, redirect; on mismatch re-render. Grants scopes `["swap:read","swap:write"]` unconditionally — hardcoded, never derived from the client's requested scopes (Resolved planning choice 1, interview decision 26; spec §5.6 literal).

**Expected pass criteria:** all cases green; gate green.

- [ ] **Step 1:** Write the failing test covering the assertions above.
- [ ] **Step 2:** Run test, confirm 404-on-POST failure.
- [ ] **Step 3:** Implement the consent POST handler with the strict ordered gate chain.
- [ ] **Step 4:** Run test, confirm all cases green (T29 still green).
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(oauth): consent POST with ordered CSRF, rate-limit and timing-safe passphrase gates`. Body: `TDD: test/workers/consent-post.test.ts written before the consent POST handler.`

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
  - **every metadata document the provider serves resolves:** `GET /.well-known/oauth-authorization-server` → 200 JSON **and** `GET /.well-known/oauth-protected-resource` → 200 JSON (both the authorization-server and protected-resource metadata Claude's connector discovery needs); `POST /register` accepts a client (open DCR — decision 24) (covers §7 G1 well-knowns)
  - `GET /api/transactions` and `POST /mcp` (JSON-RPC initialize) without a bearer → 401 (covers §7 G1)
  - `GET /healthz` → 200 `{"status":"ok"}` through the real default export (covers §7 G1)
  - `mintToken()` succeeds with the correct passphrase, allowed Origin and valid CSRF; the token then (a) authorizes `POST /mcp` JSON-RPC `initialize` + `tools/list` (with `MCP-Protocol-Version` + allowed Origin headers) listing the four tools, and (b) authorizes `GET /api/transactions` → 200 (covers §7 G1/G2 both-surfaces acceptance)
  - default export is an `OAuthProvider` instance (constructor identity or shape assertion) (covers §7 G1)

**Expected first-run failure:** `src/index.ts` still exports the scaffold Hono app — unauthenticated `/api` returns Hello-Hono 404/200 instead of 401, and well-knowns 404.

**Implementation surface:**

- `src/index.ts`: `export default new OAuthProvider({ apiHandlers: { "/mcp": SwapMcpAgent.serve("/mcp"), "/api": apiApp }, defaultHandler: publicApp, authorizeEndpoint: "/authorize", tokenEndpoint: "/token", clientRegistrationEndpoint: "/register", scopesSupported: ["swap:read","swap:write"] })` — `serve("/mcp")` with **no** `{ binding }` argument (spec M8; verified against `node_modules/agents/dist/mcp.d.ts` in T1 Step 3); token storage via the `env.OAUTH_KV` convention (no `kv` option exists in 0.8.1). `export { SwapMcpAgent, SwapCoordinator, RateLimiter }`. `apiApp` here is a thin Hono app calling `createApiApp(buildDefaultApiDeps(env))` per request; the MCP transport guard (`transportGuard`) runs in `SwapMcpAgent`'s fetch path before tool dispatch; `assertAudience` runs on props before every tool handler (already wired via registrars' deps).
- `test/helpers/mintToken.ts`: `export async function mintToken(): Promise<{ accessToken: string; clientId: string }>` — production-flow helper; always yields a both-scopes token (decision 26 — the consent flow cannot mint anything narrower)

**Expected pass criteria:** integration project green; all prior projects green; gate green.

- [ ] **Step 1:** Write the failing integration test + `mintToken` helper covering the assertions above; add the integration project to `vitest.config.ts`.
- [ ] **Step 2:** Run test, confirm the scaffold-Hono failure mode.
- [ ] **Step 3:** Rewire `src/index.ts` to the `OAuthProvider` default export + DO re-exports.
- [ ] **Step 4:** Run test, confirm green (all prior projects still green).
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(app): OAuthProvider entry wiring mcp and api surfaces with public consent`. Body: `TDD: test/integration/oauth-happy.test.ts written before rewiring src/index.ts.`

---

### Task 32: Integration negative paths

**Domain:** general-purpose
**Files:**

- Test: `test/integration/oauth-negative.test.ts` (fixes land in existing modules if red beyond expectation)
- Test: `test/workers/scope-seam.test.ts` — workers-pool read-only-token rejection at the app-owned auth seam (replaces the deleted KV-injection helper)

> **BLOCKER fix — no token-forging seam.** The earlier `test/helpers/mintTestToken.ts` KV props-injection helper is **deleted and must not be created**: `@cloudflare/workers-oauth-provider` end-to-end-encrypts grant props under the access token as key material, so no forged read-only bearer is decryptable and forcing a seam would be a real bypass of `completeAuthorization`. Decision 26 stands — the **production consent flow always grants both scopes** and no narrower token is mintable. Write-path rejection is instead proven at the **app-owned seam** (fake `deps.getProps → { scopes: ["swap:read"] }`) against the real registrar and the real route.

**Test contract (workers-pool scope seam — `test/workers/scope-seam.test.ts`):**

- Test names: `read-only props are rejected by the real registerExecuteSwap registrar`, `read-only props are rejected by the real POST /api/swap route`, `read props still succeed on read paths`
- Assertions:
  - the **real `registerExecuteSwap`** registrar (T23), invoked with `deps.getProps` faked to return `{ scopes: ["swap:read"] }`, returns the `toErrorEnvelope("forbidden", …)` shape and the fake coordinator spy is untouched (covers §7 G2/G10 read-only rejection at the tool registrar)
  - the **real `POST /api/swap`** route (T26) exercised via the T25 props-adapter seam with `props.scopes = ["swap:read"]` → HTTP 403 forbidden envelope, coordinator spy untouched (covers §7 G2/G4 read-only rejection at the REST route)
  - the same read-only props **succeed** on `POST /api/quote` and the `get_quote` registrar (read paths still work — the gate is scope-specific, not a blanket denial) (covers §7 G2 read-path parity)

**Test contract (integration — `test/integration/oauth-negative.test.ts`):**

- Test names: `consent POST without a valid csrf token is rejected before passphrase evaluation`, `foreign resource at authorize is rejected`, `POST /mcp with a disallowed Origin is rejected before dispatch`, `POST /mcp with a missing MCP-Protocol-Version is rejected before dispatch`, `sixth failed passphrase from one IP returns 429`, `429 recovers after the rate-limit window expires`, `minted token props carry no secret`, `redaction leak test end-to-end`, `G9 REST mid-swap visibility shows submitted before the swap resolves`, `get_quote output is accepted verbatim as expectedAmountOut`
- Assertions:
  - replaying/omitting the CSRF token on the real `POST /authorize` → rejection; a subsequent GET+valid dance still works (covers §7 G2 CSRF integration path)
  - authorize request with `resource=https://attacker.example/mcp` → rejected; no token mintable (covers §7 G2 foreign-resource)
  - `POST /mcp` (bearer valid) with an Origin **not** in `ALLOWED_ORIGINS` → rejected by `transportGuard` **before** tool dispatch (no coordinator/service call happens); and `POST /mcp` with the `MCP-Protocol-Version` header **absent** → rejected before dispatch (covers Major 4 — transport-guard wiring proven on the `/mcp` path, §5.5(a))
  - five wrong-passphrase POSTs from `CF-Connecting-IP: 9.9.9.9` then a sixth → HTTP 429 `rate_limited` (covers §7 G2 429-after-limit via the real `RateLimiter`)
  - after the 429, advancing the injected `RateLimiter` clock past the 10-minute window lets a subsequent correct-passphrase dance from the same IP mint a token again — window-expiry recovery, operator not permanently locked out (covers §7 G2 window-expiry recovery)
  - **G9 REST mid-swap visibility:** fire `POST /api/swap` **unawaited** with a fake signer parked in `waitForReceipt`, then `GET /api/transactions/:id` over `exports.default.fetch()` returns `status:"submitted"` (with `txHash`) **before** the swap `POST` promise resolves — the REST surface half of G9, mirroring the workers-pool `get_transaction` proof in T21 (covers §7 G9 REST integration half — Major 3)
  - the read-only-token write-path rejection is covered by the workers-pool scope-seam test above (no token forging here); the integration suite asserts only the always-both-scopes production token works on every surface (covers §7 G2/G4 — decision 26)
  - decoding what the surfaces echo of identity (e.g. a transactions row's `userId`, MCP tool behavior) never exposes the passphrase or any secret; a forced `internal` error response body contains **no long hex and no secret-name values** (envelope carries no secret) (covers §7 G2 no-secret props + §7 G10 integration leak test)
  - a `get_quote` result's `quotedAmountOut` fed **verbatim** as the `expectedAmountOut` of a subsequent `execute_swap` is accepted (byte-identical reuse) (covers §7 G3 reusable-floor — optional scope nit)

**Expected first-run failure (coverage-ratchet / regression-pin task — sanctioned exemption from watch-it-fail; this plan is the human authorisation):** the scope-seam and most integration assertions exercise already-built behavior, so they are **regression pins**, not Iron-Law red. The new transport-guard and G9-REST assertions may genuinely fail if wiring is missing (fix in the named modules). Do not claim Iron-Law red for the regression-pin assertions; the deliberate-inversion check (invert one assertion, watch it fail for the right reason, restore) is used only to confirm the pin bites.

**Implementation surface:** none expected beyond wiring fixes surfaced by the transport-guard / G9-REST assertions.

**Expected pass criteria:** all green; gate green.

- [ ] **Step 1:** Write both failing tests — `test/workers/scope-seam.test.ts` (read-only rejection at the real registrar + real route) and `test/integration/oauth-negative.test.ts` (incl. the transport-guard, window-expiry, G9-REST, and verbatim-floor assertions); apply the deliberate-inversion red check to confirm each regression pin bites.
- [ ] **Step 2:** Confirm the inverted assertion fails as expected; restore it. Confirm the transport-guard / G9-REST assertions are genuinely red if their wiring is missing.
- [ ] **Step 3:** Fix any genuine wiring defect surfaced (transport-guard on `/mcp`, G9 REST visibility) in the named modules.
- [ ] **Step 4:** Run tests, confirm all green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `test(integration): negative oauth, rate-limit, transport-guard, scope-seam and redaction paths`. Body: `TDD: test/workers/scope-seam.test.ts and test/integration/oauth-negative.test.ts drive the app-owned seam and the full worker via exports.default.fetch(); read-only rejection proven at the registrar/route (no token forging).`

---

### Task 33: Documentation (Diátaxis)

**Domain:** general-purpose
**Files:**

- Create: `docs/tutorials/getting-started.md` — tutorial: stand up locally (`pnpm install`, `pnpm dev`), mint a token via the OAuth dance, run a mocked quote
- Create: `docs/how-to/configure-secrets-and-deploy.md` — how-to: set the four secrets via `wrangler secret put`, replace placeholder KV/D1/DO ids, deploy, run the smoke script; **must note the DO migrations-tag deploy rule** (one migration tag per DO class — `v1` SwapCoordinator, `v2` SwapMcpAgent, `v3` RateLimiter — and never `wrangler deploy` mid-build) **and the global-rate-limit lockout tradeoff** (the 20-failure global budget can briefly lock all operators out; it self-recovers after the 10-minute window expires)
- Create: `docs/how-to/one-time-usdc-approval.md` — how-to: run the one-time legacy USDC→Universal Router `approve` out-of-band (the service never auto-sends it; `approval_required` recovery)
- Create: `docs/how-to/reconcile-stranded-submitted.md` — the named reconciliation runbook: look up the recorded `txHash` on-chain, determine the real outcome, mark the row `confirmed` (with `actualAmountOut`/`gasUsed`) or `failed` (with `errorCode`); **must state that a `pending` row with no `txHash` is safe to mark `failed`**
- Create: `docs/reference/api-and-data-model.md` — reference: MCP tool schemas (incl. optional `expectedAmountOut`, cursor, `result` field), the four REST endpoints, `swaps` columns + status lifecycle, the full 11-code error allowlist
- Create: `docs/explanation/architecture-decisions.md` — explanation: why OAuthProvider + McpAgent, RateLimiter DO over KV, SwapCoordinator serialization, drift-floor semantics (caller floor vs API-embedded floor), the `approval_required` no-auto-send stance, custodial trade-offs, why `timed_out` is a call result not a row status; **must explain the in-DO mutex is per-live-instance and does not survive DO eviction/hibernation — cross-eviction safety rests on the single-in-flight-swap invariant + D1 reconciliation, not the mutex** (do not overstate the mutex's guarantee)
- Test: `test/node/docs-presence.test.ts`

**Test contract:**

- File: `test/node/docs-presence.test.ts` (fs-based presence/content check — the concrete form of §7 G13's "integration presence check")
- Test names: `one artifact exists per Diátaxis quadrant`, `the reconciliation runbook exists by its spec-mandated name and notes the pending-row rule`, `the one-time approval how-to exists`, `reference covers the full error allowlist`, `the explanation doc carries the mutex-eviction caveat`, `the deploy how-to carries the migrations-tag and global-lockout notes`
- Assertions:
  - each of the six files above exists and is non-empty (covers §7 G13 one-per-quadrant + named artifacts)
  - `docs/how-to/reconcile-stranded-submitted.md` contains the phrase matching /pending.*no.*txHash.*safe.*failed/i (covers §7 G13 pending-row note)
  - `docs/reference/api-and-data-model.md` mentions every member of `ERROR_CODES` (imported from `src/errors.ts` so the doc can never drift silently) (covers §7 G13/G10)
  - `docs/explanation/architecture-decisions.md` contains the mutex-eviction caveat (matches /mutex.*(evict|hibernat)/i) — the mutex is per-live-instance, cross-eviction safety rests on single-in-flight + D1 reconciliation (covers the T21 mutex-eviction doc bullet)
  - `docs/how-to/configure-secrets-and-deploy.md` contains the migrations-tag deploy rule (matches /migration.*tag/i) and the global-lockout tradeoff note (covers the T28/T33 ops-doc notes)

**Expected first-run failure:** `ENOENT` — docs files absent.

**Implementation surface:** the six Markdown files, authored under the writing-documentation skill's Diátaxis discipline (grounded in the real code built in T1–T32; Strunk style rules; each doc serves one reader/one goal; no invented endpoints — every claim traceable to the implemented surface).

**Expected pass criteria:** presence test green; gate green.

- [ ] **Step 1:** Write the failing presence test covering the assertions above.
- [ ] **Step 2:** Run test, confirm `ENOENT` failure.
- [ ] **Step 3:** Author the six Diátaxis docs grounded in the built code.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `docs: Diátaxis documentation set with approval and reconciliation how-tos`. Body: `TDD: test/node/docs-presence.test.ts written before the documentation files.`

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

- [ ] **Step 1:** Write the failing presence test covering the assertions above.
- [ ] **Step 2:** Run test, confirm `ENOENT` failure.
- [ ] **Step 3:** Author `scripts/smoke.ts`; link it from the deploy how-to.
- [ ] **Step 4:** Run test, confirm green.
- [ ] **Step 5:** Run full gate.
- [ ] **Step 6:** Commit. Message: `feat(scripts): manual real-chain smoke script`. Body: `TDD: test/node/smoke-presence.test.ts written before scripts/smoke.ts.`

---

## Spec Coverage Map

Every §2 goal and §7 acceptance criterion → covering task(s). (§7 criteria are keyed by their goal ids.)

| Goal / AC | Covering tasks |
|---|---|
| **G1** — OAuthProvider default export; `/mcp` + `/api` reject without bearer; constant `/healthz`; well-knowns | T27 (healthz constant/no-oracle), T31 (default export, well-knowns, unauthenticated rejection, both surfaces) |
| **G2** — consent dance, strict Origin/Referer + CSRF-before-passphrase (single-use nonce, replay-rejected), foreign-resource rejection, transport-guard + audience wiring, props content + no secret, SHA-256-then-`timingSafeEqual`, RateLimiter 5/IP + 20 global + concurrency + window expiry + CF-Connecting-IP, read-only token rejected by write paths at the app-owned seam (no token forging) | T6 (constant-time compare via `crypto.subtle.timingSafeEqual`), T7 (scope gate), T24 (audience per-registrar wrapper), T28 (all RateLimiter budgets/concurrency/expiry), T29 (CSRF binding + display + redirect/resource validation), T30 (strict Origin/Referer, ordered gate chain, nonce-consumed-any-outcome, props, IP source, wrong-passphrase), T31 (token accepted by both surfaces, both well-knowns), T32 (workers-pool scope-seam read-only rejection at real registrar+route; integration CSRF/foreign-resource/transport-guard/429/window-recovery/no-secret) |
| **G3** — get_quote reusable/no-write; execute_swap terminal payload; drift both branches; approval_required; timeout stays submitted + `timed_out`, no fifth status; revert distinct; list/get; pagination + tampered cursor | T8 (no fifth status in schema), T10/T11 (cursor + pagination), T12 (drift math both branches), T16 (get_quote form/no-write), T17 (drift/approval/terminal payload), T19 (workers-pool abort proofs), T20 (timeout vs revert, deadline bound), T22 (read tools + pagination + tamper), T23 (execute_swap payload + floor forwarding) |
| **G4** — REST mirror payload/scope parity, expectedAmountOut, timed_out passthrough, props-adapter, pagination | T25 (props adapter + status mapping), T26 (all four routes incl. read-only rejection, floor, timeout, pagination), T32 (integration write-path rejection) |
| **G5** — EXACT_INPUT/CLASSIC/string chain ids/sentinel; routing assertion + routing-aware accessor; spread `/swap` + null-permit strip; 8s timeout; retry policy; direction-aware balances + gas headroom; receipt success vs revert; address-constants test | T9 (constants), T13 (shapes/assertion/accessor/spread/sentinel), T14 (timeout/retry/never-`/swap`), T15 (balances, receipt outcomes), T17 (gas headroom in orchestration) |
| **G6** — slippage cap/default, amount>0, insufficient_balance direction/gas-aware, deadline default, caller-floor abort pre-submission, approval_required pre-submission | T12 (pure rails), T17 (orchestrated rails + aborts), T19 (workers-pool proof) |
| **G7** — concurrent execute_swap serialized by in-DO promise-chain mutex; no overlapping submit; nonce order | T21 (dedicated concurrency test), T15/T20 (receipt disambiguation feeding G7's row) |
| **G8** — one row per attempt; pending→submitted→confirmed; revert → failed/swap_failed + txHash; aborts → failed + errorCode + no txHash; timeout leaves submitted + txHash; lifecycle columns | T8 (schema/columns), T11 (transitions/dispositions), T17 (service-level), T18 (happy lifecycle in D1), T19 (abort dispositions in D1), T20 (timeout/revert rows) |
| **G9** — mid-swap `submitted` visible before execute_swap returns; live reads | T18 (eager-write proof), T21 (dedicated workers-pool interleaving test), T22/T26 (live get paths), T32 (REST integration half — `GET /api/transactions/:id` shows `submitted` before the unawaited `POST /api/swap` resolves) |
| **G10** — closed allowlist (`quote_expired` absent, `approval_required` present); no raw messages; log/envelope leak tests | T3 (allowlist/classify/envelope), T4 (redaction + leak tests), T22/T23 (envelope-only tool errors), T25/T26 (HTTP mapping), T32 (integration leak test) |
| **G11** — `pnpm test` with zero network; `pnpm typecheck` clean; smoke exists, manual-only | every task's gate; global mocking constraint; T34 (smoke presence + suite exclusion) |
| **G12** — placeholder-only bindings, `nodejs_compat` uncommented, cf-typegen succeeds; fail-closed env | T2 (wrangler + typegen + canary), T5 (validateEnv), T18/T24/T28 (DO bindings kept placeholder, typegen re-run) |
| **G13** — one doc per quadrant; one-time-approval how-to; named runbook incl. pending-row note | T33 (six named files + content assertions), T34 (smoke documented) |

**§6 ordering compliance:** T3–T7 (cross-cutting) → T8–T12 (schema/repository/constants/pure rails) → T13–T17 (engine + swapService incl. balance rail, which first appears with the ViemSigner seam per M7) → T18–T21 (coordinator incl. both drift branches, approval, gas headroom, timeout/revert, disposition, concurrency) → T22–T27 (MCP tools, REST, props middleware, healthz) → T28–T32 (RateLimiter, CSRF, consent, provider wiring, integration) → T33–T34 (docs, smoke). Dependencies always precede consumers; integration breadth strictly increases. (T1–T2 scaffold the toolchain and bindings ahead of all component work.)

**Self-review checklist (executed):** (1) spec coverage — every G1–G13 AC row above maps to ≥1 assertion bullet; no gaps found. (2) Placeholder scan — no TBD/TODO/"fill in"/"similar to Task N" present; every "reject/handle" claim carries a named assertion. (3) Type consistency — `ErrorCode` (T3), `redact` (T4), `ValidatedEnv` (T5), `timingSafeEqualDigest` (T6), `AuthProps`/`SINGLE_USER_ID` (T7), `swaps` schema (T8), address constants (T9), cursor codec (T10), `TransactionsRepository` (T11), `ExecuteSwapInput`/`checkDrift` (T12), `TradingApiClient`/`ClassicQuoteResponse` (T13), `ViemSigner`/`ReceiptOutcome` (T15), `SwapServiceDeps`/`QuoteResult` (T16), `SwapResult` (T17), `SwapCoordinator` (T18), `ToolDeps` (T22), `errorCodeToHttpStatus`/`errorResponse` (T25), `createApiApp`/`buildDefaultApiDeps` (T26), `RateLimiter` (T28), CSRF codec (T29) are declared before every later use. (4) Dependency order verified — no task references a symbol/file/binding/migration a later task produces. (5) Granularity — one green commit per task; red-green inside each task. (6) Test-first — every task's Step 1 is a failing test with a stated expected failure mode; T19/T32 (pure integration-breadth tests over existing behavior) use the sanctioned deliberate-inversion red check and say so. (7) Traceability — every assertion bullet cites a §7 goal id or is marked scaffolding.
