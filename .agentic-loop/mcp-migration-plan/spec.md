# swap-mcp — Implementation Spec

**Repo:** `swap-mcp` · **Branch:** `feat/mcp-migration-plan` · **Date:** 2026-07-12
**Deliverable:** An MCP + HTTP swap application on Cloudflare Workers (Hono), modeled on `rocksolid-strata-os/apps/agent-api`, that swaps ETH↔USDC on Ethereum mainnet via the Uniswap Trading API + viem, with OAuth-guarded access, a custodial server hot wallet, and full transaction-lifecycle tracking in D1.

---

## §0 Interview Trace (force-interview triggered)

**Trigger scan of `source.md`:** The prose-context directive **"Interview me in depth on design decisions"** (line 16) matched the force-interview trigger phrase `design decisions` used as an imperative. This sets `force-interview: true`. No other line-anchored `Default:`, `tbd`, `unsure`, `either`, or `stop and ask` triggers were present. The addenda contributed two hard constraints (OAuth for MCP auth; no AI-attribution commit trailers).

**Resolution:** The controller conducted three in-depth interview rounds plus a follow-up **before** this planning pass. All fifteen decisions below are recorded as verbatim human authorisations and are treated as literal authority. Because the interviews are complete, force-interview is **satisfied**; only genuinely-still-open items appear in §9.

**Decision map (interview answer → spec section):**

| # | Decision (verbatim intent) | Resolved in |
|---|---|---|
| 1 | Custodial server hot wallet, single DB user, key = Worker secret | §5 SwapCoordinator, §8, §10 |
| 2 | Self-contained consent screen, passphrase vs Worker secret → single DB user | §5 OAuth, §8 |
| 3 | User adds git remote; commit locally; PR at Stage 4 | §8 (process) |
| 4 | MCP tools: `get_quote`, `execute_swap`, `list_transactions` (+ `get_transaction`, see §5) | §5 MCP, §8 |
| 5 | Full REST mirror: `/api/quote`, `/api/swap`, `/api/transactions` + `/healthz` + OAuth | §5 HTTP, §8 |
| 6 | Full lifecycle tracking in D1 (incl. failed attempts) | §5 Repository/Schema, §8 |
| 7 | Safety rails: 0.5% default slippage, 5% cap, ~20min deadline, amount>0 ≤ balance | §5 engine, §7, §8 |
| 8 | Fully mocked chain in tests; injected client; manual smoke script | §6, §8 |
| 9 | Uniswap Trading API + viem | §5 engine, §8 |
| 10 | Wait-for-receipt within `execute_swap`; DB transitions in-call | §5 SwapCoordinator, §8 |
| 11 | Drizzle ORM + drizzle-kit migrations | §5 Repository, §8 |
| 12 | SwapCoordinator DO + D1 source-of-truth; eager writes; no SSE | §4, §5 SwapCoordinator, §8 |
| 13 | No AI-attribution commit trailers | §8 (process) |
| 14 | Docs via writing-documentation (Diátaxis) | §5 Docs, §8 |
| 15 | TDD every phase, non-negotiable | §6, §8 |

---

## §1 Context

The repo is a **fresh Hono-on-Cloudflare-Workers scaffold** (`src/index.ts` = "Hello Hono!", pnpm, ESM, strict TS, no MCP/tests/bindings). The task is to build a production-shaped **proof-of-concept swap service** into it, modeled on the reference app `rocksolid-strata-os/apps/agent-api`.

The service exposes the same swap capability through **two guarded surfaces** — a remote **MCP server** (for agentic clients such as Claude's connector flow) and a **REST mirror** (for conventional HTTP clients) — both behind OAuth. It swaps **ETH↔USDC on Ethereum mainnet only**, using a **custodial server hot wallet**. Every swap and its full lifecycle is persisted to **Cloudflare D1** and is live-visible while in flight.

**Consulted specialists / skills (verified against current docs):**
- **Reference-app blueprint** (`rocksolid-strata-os/apps/agent-api`): OAuthProvider entry, McpAgent tool registrars, injected-deps service layer, Drizzle usage, vitest multi-project, error-envelope discipline.
- **Uniswap engine** (`swap-integration`, `viem-integration` skills + context7): Trading API `/check_approval` → `/quote` → `/swap` flow, Universal Router calldata, viem signer.
- **Cloudflare platform** (`cloudflare:build-mcp`, `cloudflare:durable-objects`, `cloudflare:wrangler`, `agents-sdk` skills + Cloudflare docs/MCP + context7): McpAgent (SQLite DO), `@cloudflare/workers-oauth-provider`, D1 + drizzle-kit, vitest-pool-workers v0.13 (`cloudflareTest()` plugin).
- **Documentation**: `writing-documentation` (Diátaxis).
- **Process**: `tdd` skill (test-first, non-negotiable).

---

## §2 Goals

- **G1** — Deploy a single Worker whose default export is `OAuthProvider`, routing `/mcp` to the MCP agent and `/api/*` to the Hono REST app (both OAuth-guarded), with a public default handler serving `/healthz`, the OAuth `/authorize` consent screen, and provider well-knowns.
- **G2** — OAuth authentication for **both** surfaces: the self-contained `/authorize` page authenticates the operator against a **passphrase Worker secret**, and on success mints a token mapped to the single DB user; MCP `this.props` and REST middleware both carry that identity + scopes.
- **G3** — MCP tool surface: `get_quote` (read-only), `execute_swap` (exact-input, slippage-tolerant, deadline-bounded, waits for receipt), `list_transactions`, and `get_transaction` (single-row live status).
- **G4** — REST mirror with identical semantics and identical bearer auth: `POST /api/quote`, `POST /api/swap`, `GET /api/transactions`, `GET /api/transactions/:id`.
- **G5** — Swap engine that quotes and executes ETH↔USDC on mainnet via the Uniswap **Trading API** (`/check_approval` → `/quote` → `/swap`) and signs/submits/awaits via **viem**, behind **injectable interfaces** so the chain is fully mockable.
- **G6** — Safety rails enforced before any submission: slippage default 0.5% / caller-override cap 5%; deadline ~20 min; amount > 0 and ≤ wallet balance for the input token.
- **G7** — A **SwapCoordinator Durable Object** that serializes all swap execution (hot-wallet nonce safety) and **eagerly writes** every lifecycle transition to D1.
- **G8** — Full-lifecycle persistence in D1 via **Drizzle**: direction, input/output amounts, quoted-vs-actual output, slippage setting, tx hash, status (`pending → submitted → confirmed | failed`), gas used, timestamps, user id — **including failed attempts**.
- **G9** — Live transaction-state visibility: `get_transaction` / `list_transactions` / `GET /api/transactions*` reflect the row's current status **mid-swap** (D1 is the source of truth).
- **G10** — Error discipline: all tool/route errors pass through a **closed `ErrorCode` allowlist** + `classify()`; raw error messages are never reflected to callers.
- **G11** — TDD throughout: every component is built test-first with unit + integration coverage over a **fully mocked** chain, plus a manual `scripts/smoke.ts` for later human real-chain verification.
- **G12** — All bindings/secrets are **placeholders** (`OAUTH_KV`, D1 id, DO bindings, `SWAP_PRIVATE_KEY`, `AUTH_PASSPHRASE`, `UNISWAP_API_KEY`, `ETH_RPC_URL`) so the human can drop in real values without code changes.
- **G13** — Documentation authored via the Diátaxis skill (tutorial, how-to, reference, explanation) covering setup, the OAuth dance, the swap flow, and the data model.

---

## §3 Non-goals

- **Multi-pair / multi-token** — only ETH↔USDC. No arbitrary token routing.
- **Multi-chain** — Ethereum mainnet (chain id `1`) only.
- **Multi-user** — exactly one DB user; no user management, roles, or tenancy.
- **UniswapX / Dutch orders** — `routingPreference` pinned to `CLASSIC`; DUTCH_V2 explicitly excluded.
- **Per-swap Permit2 signature flow** — one-time legacy `approve` of USDC to Universal Router instead.
- **SSE / push channel** — visibility is pull-only (read D1). No streaming status.
- **Real-chain automated tests** — all chain interaction mocked; real chain only via manual smoke script.
- **Non-custodial / co-signer / MPC** — single custodial hot wallet, key as a Worker secret.
- **Third-party IdP** — self-contained passphrase consent only.
- **Per-swap USD notional cap** — not requested; only slippage/deadline/balance rails.
- **WETH handling by us** — WRAP/UNWRAP is embedded in Universal Router commands; we never touch WETH directly.
- **Lint/build tooling beyond what tests + typecheck require** — no bespoke bundler config.

---

## §4 Architecture

The Worker's default export is a **`OAuthProvider`** that guards two `apiHandlers` — `/mcp` (the `SwapMcpAgent`, a streamable-HTTP McpAgent) and `/api` (a Hono REST app) — while its public `defaultHandler` serves `/healthz`, the `/authorize` consent screen, and OAuth well-knowns. Both guarded surfaces are **thin ingress** (parse → auth → delegate) over a **pure `services/` layer** that receives a Drizzle `db` handle and an injected swap-engine client via deps — no bindings or global state leak into services. All state-changing swaps are funneled through the **`SwapCoordinator` Durable Object**, which serializes execution for hot-wallet nonce safety and **eagerly writes** each lifecycle transition to **D1**, the single source of truth that the read paths (`get_transaction`, `list_transactions`, `GET /api/transactions*`) query for live status. The swap engine itself is two injectable seams — a **Trading API client** and a **viem signer** — so the chain is fully mocked in tests and real only in the manual smoke script.

**Component boundaries:** `OAuthProvider` (entry) → { `SwapMcpAgent` (DO), `apiApp` (Hono) } → `SwapCoordinator` (DO) → `services/swapService` → { `tradingApiClient`, `viemSigner` } + `transactionsRepository` (Drizzle) → D1. Cross-cutting: `env` (Zod validation), `errors` (classify/envelope), `log` (structured JSON), `auth` (transport guard, audience check, scope gate).

---

## §5 Components

For each: **responsibility · interface · goals**.

### 5.1 wrangler config & bindings — `wrangler.jsonc`
- **Responsibility:** Declare `main = src/index.ts`, current `compatibility_date`, `nodejs_compat` flag; all bindings as **placeholders**: `kv_namespaces` → `OAUTH_KV` (placeholder id); `d1_databases` → `{ binding: "DB", database_name: "swap-mcp", database_id: "<placeholder>", migrations_dir: "drizzle" }`; `durable_objects.bindings` for `SwapMcpAgent` and `SwapCoordinator`; `migrations` block with `new_sqlite_classes: ["SwapMcpAgent", "SwapCoordinator"]`; `vars` for non-secret config (`CHAIN_ID: "1"`, `CANONICAL_MCP_URI`, `TRADING_API_BASE_URL`). Secrets (`SWAP_PRIVATE_KEY`, `AUTH_PASSPHRASE`, `UNISWAP_API_KEY`, `ETH_RPC_URL`) are documented as `wrangler secret put` placeholders, never committed.
- **Interface:** `pnpm cf-typegen` regenerates `CloudflareBindings`.
- **Goals:** G1, G7, G12.

### 5.2 Env validation — `src/env.ts`
- **Responsibility:** `validateEnv(env)` — a Zod schema layered on `CloudflareBindings` that asserts presence/shape of secrets and vars at request entry (fail-closed). `CHAIN_ID` must equal `"1"`; addresses/URIs validated.
- **Interface:** `validateEnv(env: CloudflareBindings): ValidatedEnv` (throws → mapped to `internal` error).
- **Goals:** G12, G10.

### 5.3 Logger — `src/log.ts`
- **Responsibility:** Single `log(level, fields)` structured-JSON logger; never logs secrets, private keys, or full calldata.
- **Interface:** `log("info" | "warn" | "error", Record<string, unknown>)`.
- **Goals:** G10 (observability), G7.

### 5.4 Errors — `src/errors.ts`
- **Responsibility:** Closed `ErrorCode` allowlist (`invalid_input`, `unauthorized`, `forbidden`, `not_found`, `slippage_exceeded`, `insufficient_balance`, `quote_expired`, `upstream_unavailable`, `rate_limited`, `swap_failed`, `internal`); `classify(err)` maps internal/thrown errors to a code; `toErrorEnvelope(code, message)` produces the caller-facing envelope. **Raw upstream/internal messages are never reflected** — only allowlisted codes + curated messages.
- **Interface:** `classify(err): ErrorCode`; `toErrorEnvelope(code, publicMessage): { content:[{type:"text",text}], structuredContent:{ error:{code,message} }, isError:true }`.
- **Goals:** G10.

### 5.5 Auth layer — `src/auth/*`
- **Responsibility:** Three guards, applied in order. (a) **Transport guard** (MCP): Origin allowlist + required `MCP-Protocol-Version` header, before OAuth. (b) **Audience check**: assert `props.resource === CANONICAL_MCP_URI`, fail-closed. (c) **Scope gate**: `requireScope(props, scope)` inside handlers (`swap:read` for quote/list/get; `swap:write` for execute). REST middleware validates the same bearer token (via the OAuthProvider-populated context) and applies the same scope gate.
- **Interface:** `transportGuard(req)`, `assertAudience(props, env)`, `requireScope(props, scope)`.
- **Goals:** G1, G2, G10.

### 5.6 OAuth provider + consent screen — `src/index.ts`, `src/oauth/*`
- **Responsibility:** Default Worker export = `new OAuthProvider({ apiHandlers: { "/mcp": SwapMcpAgent.serve("/mcp", { binding: "SwapMcpAgent" }), "/api": apiApp }, defaultHandler: publicApp, ... })` using KV `OAUTH_KV` for token storage; provider auto-implements token endpoint, dynamic client registration, and AS metadata well-knowns (required for Claude's connector discovery + DCR). The **`/authorize` consent screen** (Hono JSX page in `publicApp`) authenticates the operator by comparing a submitted **passphrase against the `AUTH_PASSPHRASE` secret** (constant-time compare); on match it calls `completeAuthorization({ props: { userId: SINGLE_USER_ID, scopes, resource: CANONICAL_MCP_URI } })`, encrypting props end-to-end so they surface as `this.props`. On mismatch → re-render with error (rate-limited, see §9).
- **Interface:** `publicApp` routes: `GET/POST /authorize`, `GET /healthz`; provider-served well-knowns.
- **Goals:** G1, G2.

### 5.7 MCP agent + tools — `src/mcp/SwapMcpAgent.ts`, `src/mcp/tools/*`
- **Responsibility:** `class SwapMcpAgent extends McpAgent<Env>` with `server = new McpServer(...)`; `init()` registers tools via per-tool registrars `registerGetQuote(server, deps)`, `registerExecuteSwap(...)`, `registerListTransactions(...)`, `registerGetTransaction(...)`, with injected `deps = { db, coordinator, engine, getProps }`. Tools use bare **Zod v4 ZodRawShape** schemas, return `{ content:[{type:"text",text}], structuredContent }`, and route all failures through `toErrorEnvelope`.
  - **`get_quote`** (read-only, scope `swap:read`): input `{ direction: "ETH_TO_USDC" | "USDC_TO_ETH", amountIn: string }` → calls engine `getQuote`; returns quoted output, price, slippage default, expiry. No DB write.
  - **`execute_swap`** (scope `swap:write`): input `{ direction, amountIn, slippageTolerancePct?: number (default 0.5, ≤ 5), deadlineSeconds?: number (default 1200) }` → delegates to `SwapCoordinator`; **awaits receipt**; returns final `{ status, txHash, amountOut, actualAmountOut, gasUsed, transactionId }`.
  - **`list_transactions`** (scope `swap:read`): input `{ limit?, cursor?, status? }` → repository read from D1.
  - **`get_transaction`** (scope `swap:read`): input `{ id }` → single-row live status from D1. **Justification for including `get_transaction`:** the DO+D1 visibility choice (decision 12) requires a single-row live-status read so a client that holds a `transactionId` from an in-flight `execute_swap` (or from a REST swap) can poll one row without scanning the list; `list_transactions` alone cannot address a specific in-flight row cheaply. It mirrors `GET /api/transactions/:id` (G4) for surface parity.
- **Interface:** `SwapMcpAgent.serve("/mcp")` (streamable HTTP; deprecated `/sse` skipped).
- **Goals:** G1, G2, G3, G9, G10.

### 5.8 SwapCoordinator Durable Object — `src/coordinator/SwapCoordinator.ts`
- **Responsibility:** Serialize **all** swap execution for hot-wallet nonce safety (one in-flight swap at a time per the single wallet). For each swap: (1) insert `pending` row; (2) re-quote via engine (quotes expire ~30s — never reuse a client-supplied quote); (3) enforce safety rails; (4) obtain Universal Router calldata via `/swap`; (5) sign+submit via viem → row `submitted` + `txHash`; (6) `waitForTransactionReceipt` → row `confirmed` (with `actualAmountOut`, `gasUsed`) or `failed`. **Every transition is written eagerly to D1** before returning, so reads see live status. Holds the `SWAP_PRIVATE_KEY`-derived account; creates viem clients **per-request** (not module scope).
- **Interface:** RPC method `executeSwap(params): Promise<SwapResult>`; internal transitions via `transactionsRepository`.
- **Goals:** G6, G7, G8, G9, G10.

### 5.9 Swap engine service — `src/services/swapService.ts`, `src/engine/tradingApiClient.ts`, `src/engine/viemSigner.ts`
- **Responsibility:** Pure orchestration behind two **injectable interfaces**:
  - **`TradingApiClient`**: `checkApproval`, `getQuote`, `buildSwap`. Talks to `https://trade-api.gateway.uniswap.org/v1` with headers `x-api-key: UNISWAP_API_KEY`, `Content-Type: application/json`, `x-universal-router-version: 2.0`. `/quote` uses `type:"EXACT_INPUT"`, native-ETH sentinel `0x0…0`, base-unit amounts, `slippageTolerance` percent, `swapper`, chain ids as strings `"1"`, `routingPreference:"CLASSIC"`. `/swap` spreads the quote response into the body (not nested), strips null `permitData`/`permitTransaction`; returns `{ to, data, value, chainId, gasLimit }` targeting Universal Router `0x66a9893cc07d91d95644aedd05d03f95e1dba8af`. Back off on 429 (rate limit ~10 req/s).
  - **`ViemSigner`**: `sendTransaction`, `waitForReceipt`. Uses `privateKeyToAccount(SWAP_PRIVATE_KEY)`, `createWalletClient({ account, chain: mainnet, transport: http(ETH_RPC_URL) })`; `waitForTransactionReceipt({ hash })`, success iff `receipt.status === "success"`. Also exposes `getBalance` for the balance rail. **Clients created per-request.**
  - **One-time approval:** USDC→ETH leg requires a prior legacy `approve` of USDC to Universal Router (backend one-time; documented in how-to + smoke script). ETH→USDC needs no approval.
  - Mainnet addresses embedded: USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, WETH9 `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, Universal Router `0x66a9893cc07d91d95644aedd05d03f95e1dba8af`, Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`.
- **Interface:** `swapService.getQuote(deps, input)`, `swapService.executeSwap(deps, input)` — receives client interfaces via deps; no bindings/global state.
- **Goals:** G5, G6, G3.

### 5.10 Transactions repository — `src/repository/transactions.ts`
- **Responsibility:** Drizzle data access: `drizzle(d1, { schema })`; `insertPending`, `markSubmitted`, `markConfirmed`, `markFailed`, `findById`, `list`. Encapsulates all `db.insert/update/query.swaps.findFirst/findMany`.
- **Interface:** typed repository methods taking a `db` handle.
- **Goals:** G8, G9.

### 5.11 D1 schema & migrations — `src/db/schema.ts`, `drizzle/*`
- **Responsibility:** Single `swaps` table (Drizzle schema): `id` (uuid PK), `userId`, `direction` (`ETH_TO_USDC`|`USDC_TO_ETH`), `amountIn`, `quotedAmountOut`, `actualAmountOut` (nullable), `slippageTolerancePct`, `deadlineSeconds`, `txHash` (nullable), `status` (`pending`|`submitted`|`confirmed`|`failed`), `errorCode` (nullable, from the allowlist), `gasUsed` (nullable), `createdAt`, `submittedAt`, `settledAt`. drizzle-kit generates SQL migrations into `drizzle/` (config `migrations_dir`). **Failed attempts are rows too** (`status:"failed"`, `errorCode` set).
- **Interface:** drizzle-kit `generate`; `applyD1Migrations` in test setup.
- **Goals:** G8, G9.

### 5.12 HTTP REST mirror — `src/api/apiApp.ts`, `src/api/routes/*`
- **Responsibility:** Hono app mounted at `/api`, OAuth-guarded, same scope gate as MCP. Routes delegate to the identical service/coordinator layer:
  - `POST /api/quote` → `swapService.getQuote` (scope `swap:read`).
  - `POST /api/swap` → `SwapCoordinator.executeSwap`, awaits receipt (scope `swap:write`).
  - `GET /api/transactions` → repository `list` (scope `swap:read`).
  - `GET /api/transactions/:id` → repository `findById` (scope `swap:read`).
  - Errors serialized from the same `toErrorEnvelope` codes with matching HTTP status.
- **Interface:** standard Hono handlers; JSON in/out.
- **Goals:** G4, G2, G9, G10.

### 5.13 Health — part of `publicApp`
- **Responsibility:** `GET /healthz` — unauthenticated liveness (`{ status:"ok" }`), no binding access beyond trivial.
- **Goals:** G1.

### 5.14 Docs (Diátaxis) — `docs/*`
- **Responsibility:** Authored via the writing-documentation skill: **tutorial** (stand up locally, mint a token, run a mocked quote); **how-to** (set secrets/bindings, run the one-time USDC approval, deploy, run smoke script); **reference** (MCP tool schemas, REST endpoints, `swaps` table columns + status lifecycle, error codes); **explanation** (why OAuthProvider + McpAgent, why SwapCoordinator DO serialization, custodial-wallet trade-offs).
- **Goals:** G13.

### 5.15 Smoke script — `scripts/smoke.ts`
- **Responsibility:** Manual, human-run real-chain verification via `tsx` against a deployed env: mints a token through the OAuth dance, runs a tiny real ETH→USDC quote+swap, prints the persisted row. **Not** part of the automated suite.
- **Goals:** G11.

### 5.16 package scripts — `package.json`
- **Responsibility:** `dev`, `deploy`, `test`, `typecheck`, `lint`, `format`, `cf-typegen`, `db:generate` (drizzle-kit), `smoke` (tsx). pnpm only.
- **Runtime deps:** `hono`, `agents`, `@modelcontextprotocol/sdk`, `@cloudflare/workers-oauth-provider`, `zod`, `drizzle-orm`, `viem@^2`. **Dev:** `wrangler`, `vitest@^4.1.0`, `@cloudflare/vitest-pool-workers`, `drizzle-kit`, `tsx`.
- **Goals:** G11, G12.

---

## §6 Test Strategy

**TDD is non-negotiable (G11):** each component is built **test-first** — write the failing test, implement to green, refactor. No implementation file is authored before its test.

**Vitest 4 setup:** `defineWorkersConfig` is **removed** in `@cloudflare/vitest-pool-workers` v0.13. Use the `cloudflareTest()` Vite plugin in `vitest.config.ts` with `wrangler: { configPath: "./wrangler.jsonc" }` and `miniflare.bindings.TEST_MIGRATIONS = await readD1Migrations("./drizzle")`; `setupFiles` applies them via `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`. **Storage is isolated per-test-file** (per-test isolation removed) — each test file gets a clean D1. Integration entry via `exports.default.fetch()` (preferred over deprecated `SELF`). DOs tested via stubs + `runInDurableObject()`.

**Multi-project layout:**
- **Node pool** — pure logic: `errors.classify`, safety-rail validation, quote/amount math, env validation, Zod schema shapes.
- **Workers pool** — runtime/DO: `SwapCoordinator` lifecycle transitions (mocked engine), repository against migrated D1, MCP tool handlers with injected deps.
- **Integration project** — OAuth round-trips through `exports.default.fetch()`: a helper drives the `/authorize` passphrase dance to **mint a real token**, then calls `/mcp` over JSON-RPC and `/api/*` over HTTP.

**Mocked-chain fixture policy (decision 8):** all chain I/O is behind the injected `TradingApiClient` and `ViemSigner` interfaces. Tests inject fakes returning **recorded fixtures** — `/check_approval`, `/quote`, `/swap` response bodies, and a fake receipt (`status:"success"` / `"reverted"`). No network, no RPC in the automated suite. Rate-limit (429), quote-expiry, and revert paths are exercised via fixture variants.

**Test-type × component matrix (every goal ≥1 test):**

| Component | Node | Workers | Integration | Goals |
|---|---|---|---|---|
| errors/classify + envelope | ✓ | | | G10 |
| env validation | ✓ | | | G12 |
| safety rails (slippage cap, deadline, balance>0) | ✓ | ✓ | | G6 |
| Trading API client (fixtures, 429, expiry) | ✓ | | | G5 |
| viem signer (fake receipt success/revert) | ✓ | ✓ | | G5 |
| swapService orchestration | ✓ | ✓ | | G3,G5,G6 |
| SwapCoordinator lifecycle + eager writes | | ✓ | | G7,G8,G9 |
| transactions repository (D1) | | ✓ | | G8,G9 |
| D1 schema/migrations | | ✓ | | G8 |
| MCP tools (4) via injected deps | | ✓ | ✓ | G3,G9,G10 |
| OAuth provider + passphrase consent | | | ✓ | G1,G2 |
| transport/audience/scope guards | ✓ | ✓ | ✓ | G2,G10 |
| REST routes (4) | | ✓ | ✓ | G4,G9 |
| healthz | | | ✓ | G1 |

**TDD ordering constraints:** (1) cross-cutting first — `errors`, `env`, `log`, `auth` guards; (2) then `db/schema` + migrations + repository (need D1 to write coordinator tests against); (3) then engine clients (fixture-driven) + swapService; (4) then SwapCoordinator (depends on repository + engine); (5) then MCP tools + REST routes (depend on coordinator + service); (6) then OAuth provider wiring + integration token-mint helper; (7) docs + smoke script last.

---

## §7 Acceptance Criteria

- **G1:** Default export is `OAuthProvider`; a request to `/mcp` and `/api/*` without a valid bearer is rejected; `/healthz` returns `200 {status:"ok"}` unauthenticated; provider well-knowns resolve. *(integration)*
- **G2:** Submitting the correct passphrase to `/authorize` mints a token; wrong passphrase re-renders with an error and mints nothing; the minted token's props carry `userId = SINGLE_USER_ID`, the granted scopes, and `resource = CANONICAL_MCP_URI`; both `/mcp` and `/api` accept it. *(integration)*
- **G3:** `get_quote` returns a quoted output without writing D1; `execute_swap` returns a terminal `confirmed`/`failed` result with `txHash`, `actualAmountOut`, `gasUsed`, `transactionId`; `list_transactions` and `get_transaction` return persisted rows. *(workers + integration)*
- **G4:** Each REST route returns the same payload shape as its MCP counterpart and enforces the same scope; `POST /api/swap` awaits the receipt. *(integration)*
- **G5:** With fixture responses, the engine issues `EXACT_INPUT` quotes with `routingPreference:"CLASSIC"`, chain ids as `"1"`, native-ETH sentinel; `/swap` body is spread (not nested) with null permit fields stripped; viem submits to Universal Router and resolves on receipt. *(node + workers)*
- **G6:** A swap with `slippageTolerancePct > 5` is rejected `invalid_input`; missing slippage defaults to 0.5; `amountIn ≤ 0` rejected; `amountIn > balance` rejected `insufficient_balance`; deadline defaults to 1200s. *(node + workers)*
- **G7:** Two concurrent `execute_swap` calls are serialized by the DO (no overlapping submit); nonce order preserved. *(workers)*
- **G8:** A completed swap yields exactly one `swaps` row transitioning `pending→submitted→confirmed`; a reverted swap yields a `failed` row with `errorCode` set; both persist all lifecycle columns. *(workers)*
- **G9:** While a swap is `submitted`, `get_transaction`/`GET /api/transactions/:id` returns `status:"submitted"` **before** the call returns — proving eager writes drive live visibility. *(workers)*
- **G10:** No caller-facing error contains a raw upstream/internal message; every error `code` is a member of the closed allowlist. *(node + integration)*
- **G11:** `pnpm test` passes with zero real network/RPC calls; `pnpm typecheck` clean; `scripts/smoke.ts` exists and is documented as manual-only.
- **G12:** `wrangler.jsonc` contains only placeholder ids/secrets; no real key/id committed; `pnpm cf-typegen` succeeds.
- **G13:** `docs/` contains one artifact per Diátaxis quadrant covering setup, OAuth dance, swap flow, and data model.

---

## §8 Resolved Decisions

| Decision | Authorising source | Rationale |
|---|---|---|
| Custodial single hot wallet, key as Worker secret `SWAP_PRIVATE_KEY` | Interview 1 | POC; no co-signer; one wallet ↔ one DB user. |
| Self-contained passphrase consent (`AUTH_PASSPHRASE` secret), constant-time compare | Interview 2 | No third-party IdP; single operator gate. |
| Commit locally now; PR at Stage 4 once remote exists | Interview 3 | User adds remote themselves. |
| MCP tools = `get_quote` + `execute_swap` + `list_transactions` + `get_transaction` | Interview 4 + §5.7 justification | History visibility under DO+D1 needs cheap single-row live read; mirrors REST `/:id`. |
| Full REST mirror + `/healthz` + OAuth endpoints | Interview 5 | Same auth, same service layer. |
| Full-lifecycle D1 tracking incl. failed attempts | Interview 6 | Complete auditability. |
| Slippage default 0.5% / cap 5%; deadline ~20 min (1200s); amount>0 ≤ balance; no USD cap | Interview 7 | Stated rails verbatim. |
| Fully mocked chain; injected clients; manual smoke script | Interview 8 | Deterministic tests; real chain human-run. |
| Uniswap **Trading API + viem** (not raw SDK) | Interview 9 + Research B | API returns ready-to-sign Universal Router calldata. |
| `execute_swap` waits for receipt; transitions in-call | Interview 10 | Caller gets terminal status; wall-clock wait = no Worker CPU. |
| **Drizzle ORM** + drizzle-kit migrations | Interview 11 | Matches reference app. |
| **SwapCoordinator DO + D1 source-of-truth**, eager writes, no SSE | Interview 12 | Nonce safety + live visibility via D1 reads. |
| No AI-attribution commit trailers | Interview 13 + addendum | Process constraint for all commits. |
| Docs via writing-documentation (Diátaxis) | Interview 14 | Required skill. |
| TDD every phase | Interview 15 | Non-negotiable. |
| `routingPreference: "CLASSIC"`, chain ids as strings, native-ETH sentinel, spread `/swap` body, strip null permit fields | Research B | Verified Trading API shape; avoids UniswapX signature flow. |
| One-time legacy USDC→Universal Router `approve` (no per-swap Permit2) | Research B | Backend service pattern; skips per-swap signatures. |
| `OAuthProvider` default export; `SwapMcpAgent.serve("/mcp")` streamable HTTP; `OAUTH_KV`; `new_sqlite_classes` for both DOs | Research A + C | Required for Claude connector discovery + DCR; McpAgent = SQLite DO. |
| vitest 4 `cloudflareTest()` plugin; `applyD1Migrations`; per-file isolation; `exports.default.fetch()` | Research C | `defineWorkersConfig` removed in pool-workers v0.13. |
| Closed `ErrorCode` allowlist + `classify()`; never reflect raw messages | Research A | Security/consistency of caller-facing errors. |

---

## §9 Open Questions

Each names a suggested default and the considered alternative. These are numeric/process details **not** fixed by the fifteen answers.

- **Q1 — Trading API request timeout.** Confirm: **8s per Trading API call**, mapped to `upstream_unavailable` on timeout? *(alternative: 15s — fewer false timeouts but ties up the request longer under Trading API latency; 8s chosen to fail fast within Worker limits.)*
- **Q2 — Trading API retry policy on 429/5xx.** Confirm: **up to 2 retries with exponential backoff (250ms → 500ms), jittered**, only for idempotent `/quote` and `/check_approval` — **never retry `/swap` or a submitted tx**? *(alternative: no retries — simpler but brittle against the ~10 req/s rate limit; retry-except-swap chosen to protect against double-submission.)*
- **Q3 — `list_transactions` pagination page size.** Confirm: **default `limit` 20, max 100, opaque cursor over `createdAt`**? *(alternative: offset pagination — simpler but drifts under concurrent inserts; cursor chosen for stability.)*
- **Q4 — `/authorize` passphrase rate limiting.** Confirm: **5 attempts per IP per 10 min via `OAUTH_KV` counter, then 429** for the consent POST? *(alternative: no throttle — acceptable for a single-operator POC but leaves the passphrase gate brute-forceable; throttle chosen as cheap defense-in-depth.)*
- **Q5 — Quote-expiry handling in `execute_swap`.** Confirm: the SwapCoordinator **always re-quotes immediately before `/swap`** and, if the fresh quote's output moves beyond the caller's slippage tolerance versus the original preview, aborts with `slippage_exceeded` **rather than** auto-executing? *(alternative: execute on the fresh quote regardless as long as it's within tolerance of itself — but that can surprise a caller who previewed a very different price; abort-on-drift chosen for caller safety. Note quotes expire ~30s so re-quote is mandatory either way.)*
- **Q6 — OAuth scope granularity.** Confirm the two-scope model **`swap:read` / `swap:write`** granted together at consent? *(alternative: a single `swap` scope — simpler but loses the read-only-client option; two scopes chosen to allow a future read-only token with no code change.)*

---

## §10 Risks

- **Hot-wallet key exposure.** `SWAP_PRIVATE_KEY` in a Worker secret + custodial signing is the highest-value target. *Mitigation:* key only ever materialized inside `SwapCoordinator`, never logged, never returned; per-request viem client; single wallet; POC-scoped funds. Residual risk accepted per decision 1.
- **Trading API shape/availability drift.** The `/quote` and `/swap` response contracts (spread body, null permit fields, `swap:{to,data,value,...}`) can change; the gateway can 429/5xx. *Mitigation:* client isolated behind `TradingApiClient`, fixtures pin the expected shape (a drift breaks a test, not prod silently), timeout+retry (Q1/Q2) map to `upstream_unavailable`.
- **Quote expiry mid-flow (~30s).** A reused or stale quote reverts on-chain, burning gas. *Mitigation:* coordinator always re-quotes immediately before `/swap` (Q5); never trusts a client-supplied quote.
- **DO/eager-write consistency.** If the DO crashes between submit and receipt, a row could be stranded in `submitted`. *Mitigation:* eager write of `submitted` + `txHash` means the tx is recoverable from chain; a documented reconciliation note; POC accepts manual recovery. Serialization prevents nonce collisions.
- **Placeholder bindings block deploy.** Deploying with placeholder D1/KV ids or unset secrets will fail at runtime. *Mitigation:* documented in the how-to; `validateEnv` fails closed with a clear `internal` error rather than a confusing chain error; `/healthz` stays green (no binding dependence) so liveness is distinguishable from misconfiguration.
- **vitest-pool-workers API churn.** The v0.13 change (`defineWorkersConfig` removed) means stale examples will mislead. *Mitigation:* spec pins `cloudflareTest()` + `applyD1Migrations`; version pinned in `package.json` (`vitest@^4.1.0`).
- **Rate limit / connection ceiling.** Trading API ~10 req/s and Workers' 6-simultaneous-outgoing-connection limit can throttle bursts. *Mitigation:* DO serialization naturally caps concurrency to one swap; backoff on 429 (Q2).
- **Receipt wait unbounded.** `waitForTransactionReceipt` could hang on a stuck mempool tx, holding the request open. *Mitigation:* bound the wait (tie to the swap `deadlineSeconds`, default 1200s) and map a timeout to `swap_failed` with the `txHash` persisted for later reconciliation. *(Confirm the wait bound alongside Q1 if the 1200s tie is not desired.)*
- **USDC→ETH one-time approval not run.** Without the one-time `approve`, the first USDC→ETH swap reverts. *Mitigation:* documented as an explicit operator step in the how-to and covered by the smoke script; `/check_approval` result surfaced so the coordinator can fail with a clear `invalid_input`/`upstream_unavailable` rather than a raw revert.