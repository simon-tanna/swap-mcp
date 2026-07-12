# swap-mcp — Implementation Spec

**Repo:** `swap-mcp` · **Branch:** `feat/mcp-migration-plan` · **Date:** 2026-07-12
**Deliverable:** An MCP + HTTP swap application on Cloudflare Workers (Hono), modeled on `rocksolid-strata-os/apps/agent-api`, that swaps ETH↔USDC on Ethereum mainnet via the Uniswap Trading API + viem, with OAuth-guarded access, a custodial server hot wallet, and full transaction-lifecycle tracking in D1.

---

## §0 Interview Trace (force-interview triggered)

**Trigger scan of `source.md`:** The prose-context directive **"Interview me in depth on design decisions"** (line 16) matched the force-interview trigger phrase `design decisions` used as an imperative. This sets `force-interview: true`. No other line-anchored `Default:`, `tbd`, `unsure`, `either`, or `stop and ask` triggers were present. The addenda contributed two hard constraints (OAuth for MCP auth; no AI-attribution commit trailers).

**Resolution:** The controller conducted five in-depth interview rounds plus a sixth round following validating-specs on spec v2. Across those rounds the human has answered **every** open question; all twenty-five decisions below are recorded as verbatim human authorisations and are treated as literal authority. Because the interviews are complete and no question remains open, force-interview is **satisfied**; §9 is empty by design.

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
| 16 | Quote-drift → abort with `slippage_exceeded`, write `failed` row, send no tx | §5.8, §7 (G3/G6), §8, §10 |
| 17 | OAuth scopes `swap:read` + `swap:write`, granted together at consent | §5.5, §5.6, §5.7, §5.12, §8 |
| 18 | *(Amended by decision 25.)* `/authorize` rate limit: 5 failed attempts / IP / 10 min, then 429 | §5.6, §5.6a, §7 (G2), §8, §10 |
| 19 | Receipt-wait bound tied to `deadlineSeconds` (1200s); timeout → row stays `submitted`, result `timed_out` | §5.8, §7 (G3), §8, §10 |
| 20 | Trading API: 8s per-call timeout → `upstream_unavailable`; ≤2 jittered backoff retries (250ms→500ms) for `/quote` + `/check_approval` only | §5.9, §7 (G5), §8, §10 |
| 21 | Pagination: opaque cursor over `(createdAt, id)`; default limit 20, max 100 | §5.7, §5.12, §7 (G3/G4), §8 |
| 22 | Reconciliation runbook (docs how-to) for swaps stranded in `submitted` | §5.14, §7 (G13), §8, §10 |
| 23 | **Drift floor: caller-supplied `expectedAmountOut`** — if supplied, abort `slippage_exceeded` when fresh < `expectedAmountOut × (1 − tol)`; if omitted, fresh quote is baseline and the API-embedded slippage floor (derived from `slippageTolerance` on `/quote`) is the only rail | §5.7, §5.8, §6, §7 (G3/G6), §8, §10 |
| 24 | **DCR posture: open `/register` + hardened consent** — CSRF token bound to AuthRequest, prominent client-name + exact redirect_uri display, strict redirect_uri validation | §5.6, §5.6b, §7 (G2), §8, §10 |
| 25 | **`RateLimiter` Durable Object (strongly consistent)** enforcing 5 failed/IP/10min AND global 20 failed/10min; IP from CF-Connecting-IP only — **AMENDS decision 18** (KV backend) | §5.6a, §5.17, §7 (G2), §8, §10 |

*(Decisions 16–22 authorised in Interview round 5; decisions 23–25 authorised in Interview round 6 following validating-specs REVISE on spec v2. Decision 18's KV rate-limit backend is superseded by decision 25's `RateLimiter` DO — the 5/IP/10min policy stands, the backend is amended.)*

---

## §1 Context

The repo is a **fresh Hono-on-Cloudflare-Workers scaffold** (`src/index.ts` = "Hello Hono!", pnpm, ESM, strict TS, no MCP/tests/bindings). The task is to build a production-shaped **proof-of-concept swap service** into it, modeled on the reference app `rocksolid-strata-os/apps/agent-api`.

The service exposes the same swap capability through **two guarded surfaces** — a remote **MCP server** (for agentic clients such as Claude's connector flow) and a **REST mirror** (for conventional HTTP clients) — both behind OAuth. It swaps **ETH↔USDC on Ethereum mainnet only**, using a **custodial server hot wallet**. Every swap and its full lifecycle is persisted to **Cloudflare D1** and is live-visible while in flight.

**Consulted specialists / skills (verified against current docs):**
- **Reference-app blueprint** (`rocksolid-strata-os/apps/agent-api`): OAuthProvider entry, McpAgent tool registrars, injected-deps service layer, Drizzle usage, vitest multi-project, error-envelope discipline.
- **Uniswap engine** (`swap-integration`, `viem-integration` skills + context7): Trading API `/check_approval` → `/quote` → `/swap` flow, Universal Router calldata, viem signer, routing-shape assertion.
- **Cloudflare platform** (`cloudflare:build-mcp`, `cloudflare:durable-objects`, `cloudflare:wrangler`, `agents-sdk` skills + Cloudflare docs/MCP + context7): McpAgent (SQLite DO), `@cloudflare/workers-oauth-provider`, D1 + drizzle-kit, `@cloudflare/vitest-pool-workers` ^0.18 (`cloudflareTest()` plugin), Durable-Object rate limiting.
- **Documentation**: `writing-documentation` (Diátaxis).
- **Process**: `tdd` skill (test-first, non-negotiable).

---

## §2 Goals

- **G1** — Deploy a single Worker whose default export is `OAuthProvider`, routing `/mcp` to the MCP agent and `/api/*` to the Hono REST app (both OAuth-guarded), with a public default handler serving `/healthz`, the OAuth `/authorize` consent screen, and provider well-knowns.
- **G2** — OAuth authentication for **both** surfaces: the self-contained `/authorize` page authenticates the operator against a **passphrase Worker secret** (behind a CSRF-protected form and a strongly-consistent rate limiter), and on success mints a token mapped to the single DB user; MCP `this.props` and REST middleware both carry that identity + scopes.
- **G3** — MCP tool surface: `get_quote` (read-only, output directly reusable as `expectedAmountOut`), `execute_swap` (exact-input, slippage-tolerant, deadline-bounded, optional caller-supplied floor, waits for receipt), `list_transactions`, and `get_transaction` (single-row live status).
- **G4** — REST mirror with identical semantics and identical bearer auth: `POST /api/quote`, `POST /api/swap`, `GET /api/transactions`, `GET /api/transactions/:id`.
- **G5** — Swap engine that quotes and executes ETH↔USDC on mainnet via the Uniswap **Trading API** (`/check_approval` → `/quote` → `/swap`) and signs/submits/awaits via **viem**, behind **injectable interfaces** so the chain is fully mockable; the `/quote` routing is asserted to be a known CLASSIC-family shape before any output is read.
- **G6** — Safety rails enforced before any submission: slippage default 0.5% / caller-override cap 5%; deadline ~20 min; amount > 0 and ≤ wallet balance for the input token (native vs ERC-20, gas-headroom-aware); optional caller-supplied `expectedAmountOut` drift floor.
- **G7** — A **SwapCoordinator Durable Object** that serializes all swap execution (hot-wallet nonce safety) via an in-DO promise-chain single-flight mutex and **eagerly writes** every lifecycle transition to D1.
- **G8** — Full-lifecycle persistence in D1 via **Drizzle**: direction, input/output amounts, quoted-vs-actual output, slippage setting, tx hash, status (`pending → submitted → confirmed | failed`), gas used, timestamps, user id — **including failed attempts** (drift/rail/approval aborts write a `failed` row with `errorCode` and no `txHash`).
- **G9** — Live transaction-state visibility: `get_transaction` / `list_transactions` / `GET /api/transactions*` reflect the row's current status **mid-swap** (D1 is the source of truth).
- **G10** — Error discipline: all tool/route errors pass through a **closed `ErrorCode` allowlist** + `classify()`; raw error messages are never reflected to callers; enforced redaction in `log()` and `toErrorEnvelope()`.
- **G11** — TDD throughout: every component is built test-first with unit + integration coverage over a **fully mocked** chain, plus a manual `scripts/smoke.ts` for later human real-chain verification.
- **G12** — All bindings/secrets are **placeholders** (`OAUTH_KV`, D1 id, DO bindings, `SWAP_PRIVATE_KEY`, `AUTH_PASSPHRASE`, `UNISWAP_API_KEY`, `ETH_RPC_URL`) so the human can drop in real values without code changes.
- **G13** — Documentation authored via the Diátaxis skill (tutorial, how-to, reference, explanation) covering setup, the OAuth dance, the swap flow, the data model, the **one-time USDC approval**, **and a reconciliation runbook how-to for swaps stranded in `submitted`**.

---

## §3 Non-goals

- **Multi-pair / multi-token** — only ETH↔USDC. No arbitrary token routing.
- **Multi-chain** — Ethereum mainnet (chain id `1`) only.
- **Multi-user** — exactly one DB user; no user management, roles, or tenancy.
- **UniswapX / Dutch orders** — `routingPreference` pinned to `CLASSIC`; DUTCH_V2 explicitly excluded; a non-CLASSIC-family routing in a `/quote` response fails closed rather than being handled.
- **Per-swap Permit2 signature flow** — one-time legacy `approve` of USDC to Universal Router instead.
- **Auto-sending the USDC approval transaction** — the coordinator never submits the one-time `approve`; a missing approval aborts with `approval_required` and the operator runs the approval out-of-band.
- **SSE / push channel** — visibility is pull-only (read D1). No streaming status.
- **Real-chain automated tests** — all chain interaction mocked; real chain only via manual smoke script.
- **Non-custodial / co-signer / MPC** — single custodial hot wallet, key as a Worker secret.
- **Third-party IdP** — self-contained passphrase consent only.
- **Per-swap USD notional cap** — not requested; only slippage/deadline/balance/drift rails.
- **WETH handling by us** — WRAP/UNWRAP is embedded in Universal Router commands; we never touch WETH directly.
- **OAuth token refresh / revocation customization** — beyond the `@cloudflare/workers-oauth-provider` provider defaults; no bespoke refresh or revocation UX.
- **Swap queue / backpressure** — beyond the DO single-flight mutex; no persistent queue, no retry-on-busy scheduler.
- **Lint/build tooling beyond what tests + typecheck require** — no bespoke bundler config.

---

## §4 Architecture

The Worker's default export is a **`OAuthProvider`** that guards two `apiHandlers` — `/mcp` (the `SwapMcpAgent`, a streamable-HTTP McpAgent) and `/api` (a Hono REST app) — while its public `defaultHandler` serves `/healthz`, the `/authorize` consent screen, and OAuth well-knowns. Both guarded surfaces are **thin ingress** (parse → auth → delegate) over a **pure `services/` layer** that receives a Drizzle `db` handle and an injected swap-engine client via deps — no bindings or global state leak into services. All state-changing swaps are funneled through the **`SwapCoordinator` Durable Object**, which serializes execution for hot-wallet nonce safety (in-DO promise-chain single-flight mutex) and **eagerly writes** each lifecycle transition to **D1**, the single source of truth that the read paths (`get_transaction`, `list_transactions`, `GET /api/transactions*`) query for live status. Brute-force protection on the sole passphrase gate is a separate **`RateLimiter` Durable Object** consulted by the consent POST. The swap engine itself is two injectable seams — a **Trading API client** and a **viem signer** — so the chain is fully mocked in tests and real only in the manual smoke script.

**Component boundaries:** `OAuthProvider` (entry) → { `SwapMcpAgent` (DO), `apiApp` (Hono) } → `SwapCoordinator` (DO) → `services/swapService` → { `tradingApiClient`, `viemSigner` } + `transactionsRepository` (Drizzle) → D1. Auth side-path: `publicApp /authorize` → `RateLimiter` (DO) + CSRF-token check + passphrase compare → `completeAuthorization`. Cross-cutting: `env` (Zod validation), `errors` (classify/envelope/redaction), `log` (structured JSON, redacting), `auth` (transport guard, audience check, scope gate).

---

## §5 Components

For each: **responsibility · interface · goals**.

### 5.1 wrangler config & bindings — `wrangler.jsonc`
- **Responsibility:** Declare `main = src/index.ts`, current `compatibility_date`, and **`nodejs_compat`** in `compatibility_flags` — **explicitly uncommented** (viem requires Node built-ins on Workers). All bindings as **placeholders**: `kv_namespaces` → `OAUTH_KV` (placeholder id, used only for OAuth token storage); `d1_databases` → `{ binding: "DB", database_name: "swap-mcp", database_id: "<placeholder>", migrations_dir: "drizzle" }`; `durable_objects.bindings` for **`SwapMcpAgent`, `SwapCoordinator`, and `RateLimiter`** (three DO classes); `migrations` block with `new_sqlite_classes: ["SwapMcpAgent", "SwapCoordinator", "RateLimiter"]`; `vars` for non-secret config (`CHAIN_ID: "1"`, `CANONICAL_MCP_URI`, `TRADING_API_BASE_URL`). Secrets (`SWAP_PRIVATE_KEY`, `AUTH_PASSPHRASE`, `UNISWAP_API_KEY`, `ETH_RPC_URL`) are documented as `wrangler secret put` placeholders, never committed.
- **Interface:** `pnpm cf-typegen` regenerates `CloudflareBindings`.
- **Goals:** G1, G7, G12.

### 5.2 Env validation — `src/env.ts`
- **Responsibility:** `validateEnv(env)` — a Zod schema layered on `CloudflareBindings` that asserts presence/shape of secrets and vars at request entry (**fail-closed**: any missing/malformed secret or var throws before any handler logic runs, mapped to `internal`). `CHAIN_ID` must equal `"1"`; addresses/URIs validated; `TRADING_API_BASE_URL` is checked against a **host allowlist** (only the known Uniswap gateway host) so the API key cannot egress to an attacker-controlled host. **Secrets are not carried around inside the returned `ValidatedEnv` shape** — `ValidatedEnv` exposes validated non-secret config plus **accessor functions** for secrets (`getSwapPrivateKey()`, `getAuthPassphrase()`, `getUniswapApiKey()`, `getEthRpcUrl()`), so a secret is never a plain field that can be logged or spread. Secrets are read lazily at the point of use.
- **Interface:** `validateEnv(env: CloudflareBindings): ValidatedEnv` (throws → mapped to `internal` error).
- **Goals:** G12, G10.

### 5.3 Logger — `src/log.ts`
- **Responsibility:** Single `log(level, fields)` structured-JSON logger with an **enforced redaction pass**: before serialization every field value is scrubbed against (a) known **secret-name key patterns** (`privateKey`, `passphrase`, `apiKey`, `authorization`, `rpcUrl`, etc.) → replaced with `"[redacted]"`, and (b) a **long-hex scrubber** (any `0x`-prefixed hex run beyond an address's 42 chars — e.g. private keys, raw calldata — is truncated/redacted). Redaction is a function applied unconditionally, not a caller convention.
- **Interface:** `log("info" | "warn" | "error", Record<string, unknown>)`; `redact(fields): Record<string, unknown>` (exported for reuse by `toErrorEnvelope`).
- **Goals:** G10 (observability), G7.

### 5.4 Errors — `src/errors.ts`
- **Responsibility:** Closed `ErrorCode` allowlist:
  `invalid_input`, `unauthorized`, `forbidden`, `not_found`, `slippage_exceeded`, `insufficient_balance`, `approval_required`, `upstream_unavailable`, `rate_limited`, `swap_failed`, `internal`.
  (`quote_expired` is **removed** — no path emits it; the drift/staleness cases are covered by `slippage_exceeded`, and the missing-approval case by `approval_required`.) `classify(err)` maps internal/thrown errors to a code; `toErrorEnvelope(code, message)` produces the caller-facing envelope and **runs the same enforced redaction pass** (§5.3 `redact`) over the public message so no raw secret/hex can leak through an error string. **Raw upstream/internal messages are never reflected** — only allowlisted codes + curated messages.
- **Interface:** `classify(err): ErrorCode`; `toErrorEnvelope(code, publicMessage): { content:[{type:"text",text}], structuredContent:{ error:{code,message} }, isError:true }`.
- **Goals:** G10.

### 5.5 Auth layer — `src/auth/*`
- **Responsibility:** Three guards, applied in order. (a) **Transport guard** (MCP): Origin allowlist + required `MCP-Protocol-Version` header, before OAuth. (b) **Audience check**: assert `props.resource === CANONICAL_MCP_URI`, fail-closed (this is only meaningful because the **client-supplied `resource` is validated at consent time**, §5.6 / M12). (c) **Scope gate**: `requireScope(props, scope)` inside handlers (`swap:read` for quote/list/get; `swap:write` for execute). The **two-scope model `swap:read` / `swap:write`** is a settled decision (Interview round 5); both scopes are granted together at consent. **Honest scope-model statement:** because both scopes are always co-granted today, the split provides **no runtime privilege boundary in this POC** — it exists so a future read-only token can be minted with no code change. The gate is nonetheless real and enforced: a token carrying only `swap:read` is rejected by every write path. REST middleware validates the same bearer token (via the OAuthProvider-populated context, threaded per §5.12/M9) and applies the same scope gate.
- **Interface:** `transportGuard(req)`, `assertAudience(props, env)`, `requireScope(props, scope)`.
- **Goals:** G1, G2, G10.

### 5.6 OAuth provider + consent screen — `src/index.ts`, `src/oauth/*`
- **Responsibility:** Default Worker export = `new OAuthProvider({ apiHandlers: { "/mcp": SwapMcpAgent.serve("/mcp"), "/api": apiApp }, defaultHandler: publicApp, ... })` using KV `OAUTH_KV` for token storage. **Note the `/mcp` handler uses `SwapMcpAgent.serve("/mcp")` — no `{ binding }` argument** (that overload does not match the OAuthProvider `apiHandlers` form; the exact overload is verified against the installed `agents` package types at implementation time — M8). Provider auto-implements the token endpoint, **dynamic client registration (`/register`, left open — decision 24)**, and AS metadata well-knowns (required for Claude's connector discovery + DCR).
- **DCR posture (settled — Interview round 6, decision 24):** `/register` **stays open** because the Claude connector flow depends on it. The consent surface is hardened instead: (a) the **`/authorize` consent page prominently displays the requesting client's name and the exact `redirect_uri`** so the operator eyeballs where a successful grant would be sent; (b) **strict `redirect_uri` validation** against the registered client; (c) a **CSRF token** on the consent POST (below). **Risk model recorded:** an attacker can register a client and drive the operator to `/authorize`, but cannot obtain a token without (i) knowing the passphrase and (ii) the operator visually confirming an unexpected client-name / redirect_uri on the consent screen. The passphrase gate + operator eyeballing + strict redirect validation together bound the phishing/consent surface.
- **Consent CSRF (settled — Interview round 6, decision 24 / B4):** the `GET /authorize` render issues a **single-use CSRF token bound to the parsed `AuthRequest`** (HMAC over the AuthRequest fields keyed by a server secret, or a short-TTL `OAUTH_KV` nonce), embedded as a hidden form field. `POST /authorize` **verifies the CSRF token BEFORE evaluating the passphrase**; an absent/invalid/expired/replayed token is rejected outright. An **Origin/Referer allowlist** is enforced on the POST (both this allowlist and the MCP transport guard's Origin allowlist read from a single `ALLOWED_ORIGINS` config validated in `env.ts`). Only after CSRF + Origin pass does the endpoint consult the rate limiter (§5.6a) and then compare the passphrase.
- **Resource validation (M12):** at consent time the **client-supplied `resource` parameter is validated to equal `CANONICAL_MCP_URI`**; a mismatch is rejected (so the later audience check in §5.5 is not a tautology). Only the validated canonical resource is written into props.
- **Passphrase check:** on CSRF + Origin + rate-limit + resource all passing, the operator's submitted **passphrase is compared against `AUTH_PASSPHRASE`** via the digest-based constant-time compare (§5.6c / M10); on match it calls `completeAuthorization({ props: { userId: SINGLE_USER_ID, scopes: ["swap:read","swap:write"], resource: CANONICAL_MCP_URI } })`, encrypting props end-to-end so they surface as `this.props`. **Props never contain secrets** (only `userId`, `scopes`, `resource`) — asserted by test. On mismatch → increment the rate-limiter failure counter and re-render with an error.
- **Interface:** `publicApp` routes: `GET/POST /authorize`, `GET /healthz`; provider-served well-knowns + `/register`.
- **Goals:** G1, G2.

### 5.6a Rate limiting via `RateLimiter` DO (settled — Interview round 6, decision 25; AMENDS decision 18)
- **Responsibility:** The 5-failed-attempts-per-IP-per-10-min policy from decision 16/18 **stands**, but its backend is **amended from an `OAUTH_KV` counter to a strongly-consistent `RateLimiter` Durable Object** (§5.17). Decision 25 supersedes decision 18's KV backend because **KV cannot enforce a ceiling** (no atomic increment → parallel attempts under-count; eventual consistency across colos; per-IP-only keying is both bypassable and a CGNAT lockout hazard). The DO enforces, atomically by DO serialization:
  1. **Per-IP budget:** ≤ 5 failed attempts per client IP per rolling 10-minute window.
  2. **Global budget:** ≤ 20 failed attempts across **all** IPs per rolling 10-minute window (a ceiling IP-rotation cannot evade).
  Client IP is taken **only from the trusted `CF-Connecting-IP` header** (never a spoofable `X-Forwarded-For`). On either budget being exceeded, the consent POST returns **HTTP 429 (`rate_limited`)** *without evaluating the passphrase*. **Successful authentications do not consume the failure budget.** Because counters live in a single DO instance, increments are serialized and a ceiling genuinely holds even under concurrent attempts.
- **Interface:** `RateLimiter` DO RPC: `checkAndConsume(ip): Promise<{ allowed: boolean }>` — atomically evaluates both budgets and records a failure when a passphrase attempt is about to be made; and `recordFailure(ip)` / `recordSuccess(ip)` as needed by the flow. (Implementation detail: the POST reserves against both budgets before the passphrase compare — see §5.17 for the authoritative two-method interface. Reservations are **fail-safe-closed**: an unreleased reservation (crash/throw between reserve and outcome) counts as a consumed failure, never as a dropped one. `recordSuccess` **resets the per-IP failure window** for that IP; the global budget is left untouched.)
- **Goals:** G2.

### 5.6b Consent-screen display & redirect validation (decision 24)
- **Responsibility:** The `/authorize` page renders the **requesting client's registered name and the exact `redirect_uri`** in prominent copy above the passphrase field, and validates that `redirect_uri` strictly matches a URI registered for the client before rendering. This is the operator's out-of-band phishing check.
- **Goals:** G2.

### 5.6c Constant-time passphrase compare (M10)
- **Responsibility:** The passphrase comparison **hashes both sides with SHA-256 first, then does a constant-time byte compare of the two digests** — never a raw variable-time string compare (which leaks length/prefix via timing). Digesting both sides also normalizes length so the compare reveals nothing about the secret's length.
- **Goals:** G2, G10.

### 5.7 MCP agent + tools — `src/mcp/SwapMcpAgent.ts`, `src/mcp/tools/*`
- **Responsibility:** `class SwapMcpAgent extends McpAgent<Env>` with `server = new McpServer(...)`; `init()` registers tools via per-tool registrars `registerGetQuote(server, deps)`, `registerExecuteSwap(...)`, `registerListTransactions(...)`, `registerGetTransaction(...)`, with injected `deps = { db, coordinator, engine, getProps }`. **`getProps` is a live thunk `() => this.props`** (never a value captured at `init()` time, which would go stale); any other init-captured deps must be **request-invariant** (pure services, the DO stub factory) — no per-request state is frozen at init. Tools use bare **Zod v4 ZodRawShape** schemas, return `{ content:[{type:"text",text}], structuredContent }`, and route all failures through `toErrorEnvelope`.
  - **`get_quote`** (read-only, scope `swap:read`): input `{ direction: "ETH_TO_USDC" | "USDC_TO_ETH", amountIn: string }` → calls engine `getQuote`; returns quoted output, price, slippage default, and a service-computed freshness hint (`createdAt` + ~30s; the Trading API returns no expiry field). The quoted output is surfaced **in a form directly usable as `expectedAmountOut`** for a subsequent `execute_swap` (same base-unit string, same token/decimals), so a caller who quoted can pass the value straight through as their drift floor. No DB write.
  - **`execute_swap`** (scope `swap:write`): input `{ direction, amountIn, expectedAmountOut?: string, slippageTolerancePct?: number (default 0.5, ≤ 5), deadlineSeconds?: number (default 1200) }` → delegates to `SwapCoordinator`; **awaits receipt** (bounded by `deadlineSeconds`, see §5.8); returns final `{ status, txHash, amountOut, actualAmountOut, gasUsed, transactionId, result }` where `result` may be `timed_out` if the receipt wait bound elapsed. **`expectedAmountOut` is the optional caller-supplied drift floor** (decision 23): when supplied it is the baseline for the abort-on-drift check (§5.8 step 3); when omitted the fresh re-quote is the baseline and the only price rail is the slippage floor the Trading API embeds in the `/swap` calldata (derived from the `slippageTolerance` sent on the re-quote) — the service does not compute or carry a minimum-output field itself.
  - **`list_transactions`** (scope `swap:read`): input `{ limit?, cursor?, status? }` → repository read from D1. **Pagination (settled — Interview round 5):** `limit` defaults to **20** and is capped at **100**; `cursor` is an **opaque, integrity-protected cursor over `(createdAt, id)`** — the cursor payload is **HMAC-signed (or strictly schema-validated) so a tampered cursor is rejected** with `invalid_input` rather than trusted (stable under concurrent inserts). The response returns the page of rows plus a `nextCursor` (null when the page is the last). Callers must treat the cursor as opaque and pass it back verbatim.
  - **`get_transaction`** (scope `swap:read`): input `{ id }` → single-row live status from D1. **Justification for including `get_transaction`:** the DO+D1 visibility choice (decision 12) requires a single-row live-status read so a client that holds a `transactionId` from an in-flight `execute_swap` (or from a REST swap) can poll one row without scanning the list; `list_transactions` alone cannot address a specific in-flight row cheaply. It mirrors `GET /api/transactions/:id` (G4) for surface parity.
- **Interface:** `SwapMcpAgent.serve("/mcp")` (streamable HTTP; deprecated `/sse` skipped).
- **Goals:** G1, G2, G3, G9, G10.

### 5.8 SwapCoordinator Durable Object — `src/coordinator/SwapCoordinator.ts`
- **Responsibility:** Serialize **all** swap execution for hot-wallet nonce safety (one in-flight swap at a time per the single wallet) via an **in-DO promise-chain single-flight mutex** — each `executeSwap` call appends to a serialized promise chain so submissions never overlap. **The serialization primitive is an in-DO promise-chain mutex, NOT `blockConcurrencyWhile` per request** (which is for init/consistency windows, not application-level queuing). For each swap, the lifecycle is:
  1. Insert `pending` row.
  2. Re-quote via engine immediately before submission (quotes expire ~30s — never reuse a client-supplied quote). The re-quote response is routing-shape-asserted (§5.9 / B3) before any output is read.
  3. **Abort-on-drift check (settled — Interview round 6, decision 23):**
     - **If the caller supplied `expectedAmountOut`:** compare the fresh quote's output against that floor. If `freshOutput < expectedAmountOut × (1 − slippageTolerancePct/100)` — the fresh quote has drifted below what the caller was willing to accept relative to their preview — **abort**: write the row `failed` with `errorCode = slippage_exceeded`, send **no transaction**, return the failure.
     - **If `expectedAmountOut` was omitted:** there is no caller baseline; the **fresh re-quote is itself the baseline** and the sole price rail is the **slippage floor the Trading API embeds in the `/swap` calldata**: the re-quote is issued with `slippageTolerance = slippageTolerancePct`, and the API bakes the resulting minimum output into the opaque calldata it returns — the service never computes, multiplies, or carries an `amountOutMinimum` value (that field belongs to the rejected Universal-Router-SDK manual path, not the Trading API). No separate drift abort fires in this case. This avoids the v2 double-counting bug (comparing fresh to fresh × (1 − tol) with the same tolerance the router already enforces made the guard a near-no-op).
  4. **Approval gating (USDC→ETH only — M4):** call `/check_approval` **before** `/swap`. If it returns a **non-null approval** (an `approve`/permit transaction is required), **abort WITHOUT submitting**: write the row `failed` with `errorCode = approval_required`, send **no swap and no approval transaction** (the coordinator **never auto-sends the approval tx**), and return the failure. The operator runs the one-time approval out-of-band (how-to + smoke script). ETH→USDC skips this step (no approval needed).
  5. Enforce the remaining safety rails (amount > 0 and ≤ balance with the direction-aware balance source and gas headroom, §5.9 / M1/M2; slippage ≤ 5%; deadline bound). Any rail failure here **writes the `pending` row to `failed`** with the corresponding `errorCode` and sends no transaction (§ M6).
  6. Obtain Universal Router calldata via `/swap` (the API embeds the slippage-derived minimum-output floor inside the returned calldata).
  7. Sign + submit via viem → row `submitted` + `txHash`.
  8. `waitForTransactionReceipt` → row `confirmed` (with `actualAmountOut`, `gasUsed`) or `failed` (a reverted swap's `failed` row retains its `txHash`, unlike pre-submit aborts).
- **Receipt-wait error disambiguation (M3):** `waitForTransactionReceipt` throws on **both** timeout and revert; the coordinator **branches on the error type**. A `WaitForTransactionReceiptTimeoutError` (or the configured bound elapsing) → **row stays `submitted`**, call result `timed_out` (never mapped to `failed`). A **revert** (receipt with `status:"reverted"`, or a revert error) → **row `failed`** with `errorCode = swap_failed`. A timeout is **never** written as `failed`.
- **Receipt-wait bound (settled — Interview round 5):** the receipt wait is **bounded by the swap's `deadlineSeconds`** (default 1200s). On timeout the coordinator does **not** invent a new terminal status: the **row stays `submitted`** with its `txHash` recorded, and the **call result reports `result: "timed_out"`** so the caller knows to reconcile later (see §5.14 runbook). This 1200s ceiling is **client-transport-bound** — a DO handling a request has no fixed CPU/wall cap while the invoking client stays connected (platform-safe per Cloudflare DO docs), so the bound is the swap deadline, not a platform limit. **Status enum vs result — explicit distinction (kept intentionally):** the `swaps.status` enum remains exactly `pending | submitted | confirmed | failed` (four values). `timed_out` is a **result of an `execute_swap` call**, never a fifth row status. Implementers must not add a `timed_out` status column value.
- **Rail/drift/approval failure disposition (M6):** any post-`pending` abort (drift, approval, or a safety rail) writes the existing row to **`failed` with its `errorCode` and no `txHash`** — the row is never deleted. This keeps G8's one-row-per-attempt claim intact and gives a `pending → failed` lifecycle assertion.
- **Every transition is written eagerly to D1** before returning, so reads see live status. Holds the `SWAP_PRIVATE_KEY`-derived account (read via the secret accessor, never stored as a plain field); creates viem clients **per-request** (not module scope).
- **Interface:** RPC method `executeSwap(params): Promise<SwapResult>` (where `SwapResult.result ∈ { "ok", "timed_out" }` alongside the terminal/interim `status`); internal transitions via `transactionsRepository`.
- **Goals:** G6, G7, G8, G9, G10.

### 5.9 Swap engine service — `src/services/swapService.ts`, `src/engine/tradingApiClient.ts`, `src/engine/viemSigner.ts`
- **Responsibility:** Pure orchestration behind two **injectable interfaces**:
  - **`TradingApiClient`**: `checkApproval`, `getQuote`, `buildSwap`. Talks to `TRADING_API_BASE_URL` (host-allowlisted to the Uniswap gateway `https://trade-api.gateway.uniswap.org/v1`) with headers `x-api-key: UNISWAP_API_KEY`, `Content-Type: application/json`, `x-universal-router-version: 2.0`. `/quote` uses `type:"EXACT_INPUT"`, native-ETH sentinel `0x0000000000000000000000000000000000000000`, base-unit amounts, `slippageTolerance` as **percent** (the API contract — see §5.9 slippage-units note), `swapper`, chain ids as strings `"1"`, `routingPreference:"CLASSIC"`. **Routing-shape assertion (B3):** after `/quote`, the client asserts `response.routing ∈ {CLASSIC, WRAP, UNWRAP}`; **anything else fails closed with `upstream_unavailable`**. The quoted output is read via a **routing-aware accessor** (which knows where the output amount lives per routing family) — **never a bare `quote.output.amount`** that would throw if a UniswapX-shaped body were returned. `/swap` spreads the quote response into the body (not nested), strips null `permitData`/`permitTransaction` (the slippage-derived minimum-output floor is embedded by the API inside the returned calldata, not a request field); returns `{ to, data, value, chainId, gasLimit }` targeting Universal Router `0x66a9893cc07d91d95644aedd05d03f95e1dba8af`.
    - **Slippage units (nit):** `slippageTolerancePct` is a **percent** at the API and MCP boundary (e.g. `0.5`), but all internal drift math uses the **fraction** (`pct / 100`). A unit test pins both the value sent to the API and the fraction used in math.
    - **Timeout + retry policy (settled — Interview round 5):** every Trading API call has an **8-second per-call timeout**; a timeout (or the gateway being unreachable) maps to **`upstream_unavailable`**. On `429`/`5xx`, the client performs **at most 2 jittered exponential-backoff retries — attempt-1 base 250ms, attempt-2 base 500ms (each jittered)** — **only** for the idempotent `/quote` and `/check_approval` calls. **`/swap` is never retried**, and a **submitted transaction is never re-sent**, to eliminate any double-submission risk on a money-moving path.
  - **`ViemSigner`**: `sendTransaction`, `waitForReceipt`, and **direction-aware balance reads (M2)**. The single `getBalance` is **replaced/extended** into two methods: **`getNativeBalance(address): bigint`** (native ETH via viem `getBalance`, 18 decimals — the ETH→USDC input-balance source) and **`getErc20Balance(token, address): bigint`** (USDC `balanceOf`, 6 decimals — the USDC→ETH input-balance source). Uses `privateKeyToAccount(<secret via accessor>)`, `createWalletClient({ account, chain: mainnet, transport: http(<rpc via accessor>) })`; `waitForTransactionReceipt({ hash })`, success iff `receipt.status === "success"`, revert iff `"reverted"`. **Clients created per-request.**
  - **Balance rail with gas headroom (M1):** the balance check is direction-aware. **ETH→USDC:** require `amountIn + gasLimit × maxFeePerGas + buffer ≤ nativeBalance` (input and gas both come out of native ETH, so gas headroom is mandatory — spending the full native balance would leave nothing for gas). **USDC→ETH:** require `amountIn ≤ erc20Balance(USDC)` for the input, and separately require the native balance covers `gasLimit × maxFeePerGas` (gas is paid in ETH regardless of direction). A shortfall → `insufficient_balance`.
  - **One-time approval:** USDC→ETH leg requires a prior legacy `approve` of USDC to Universal Router (backend one-time; documented in how-to + smoke script). The coordinator **detects a missing approval via `/check_approval` and aborts `approval_required`** (§5.8 step 4) — it never sends the approval itself. ETH→USDC needs no approval.
  - **Mainnet addresses embedded (verified constants — see §5.11 address-constants test):** USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, WETH9 `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, Universal Router `0x66a9893cc07d91d95644aedd05d03f95e1dba8af`, Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`, and the **native-ETH zero-address sentinel `0x0000000000000000000000000000000000000000`**. These live as named exported constants asserted by a dedicated unit test against known-good checksummed values (G5 acceptance).
- **Interface:** `swapService.getQuote(deps, input)`, `swapService.executeSwap(deps, input)` — receives client interfaces via deps; no bindings/global state.
- **Goals:** G5, G6, G3.

### 5.10 Transactions repository — `src/repository/transactions.ts`
- **Responsibility:** Drizzle data access: `drizzle(d1, { schema })`; `insertPending`, `markSubmitted`, `markConfirmed`, `markFailed`, `findById`, `list`. Encapsulates all `db.insert/update/query.swaps.findFirst/findMany`. `list` implements the opaque, integrity-protected `(createdAt, id)` cursor pagination (default 20, max 100) and returns `{ rows, nextCursor }`; a tampered/invalid cursor is rejected (`invalid_input`).
- **Interface:** typed repository methods taking a `db` handle.
- **Goals:** G8, G9.

### 5.11 D1 schema & migrations — `src/db/schema.ts`, `drizzle/*`
- **Responsibility:** Single `swaps` table (Drizzle schema): `id` (uuid PK), `userId`, `direction` (`ETH_TO_USDC`|`USDC_TO_ETH`), `amountIn`, `expectedAmountOut` (nullable — caller-supplied floor, decision 23), `quotedAmountOut`, `actualAmountOut` (nullable), `slippageTolerancePct`, `deadlineSeconds`, `txHash` (nullable), `status` (`pending`|`submitted`|`confirmed`|`failed` — **exactly these four; no `timed_out` status**, see §5.8), `errorCode` (nullable, from the allowlist), `gasUsed` (nullable), `createdAt`, `submittedAt`, `settledAt`. drizzle-kit generates SQL migrations into `drizzle/` (config `migrations_dir`). **Failed attempts are rows too** (`status:"failed"`, `errorCode` set, no `txHash` for pre-submit aborts). The `(createdAt, id)` ordering backs the list cursor. Mainnet address constants + native sentinel (§5.9) ship as exported constants with a unit test asserting each equals its known-good checksummed value.
- **Interface:** drizzle-kit `generate`; `applyD1Migrations` in test setup.
- **Goals:** G8, G9.

### 5.12 HTTP REST mirror — `src/api/apiApp.ts`, `src/api/routes/*`, `src/api/middleware/props.ts`
- **Responsibility:** Hono app mounted at `/api`, OAuth-guarded, same scope gate as MCP (`swap:read` / `swap:write`). **Props threading (M9):** OAuthProvider populates identity on `c.executionCtx.props`, which Hono handlers do not read automatically. A dedicated **adapter middleware** reads `c.executionCtx.props` and calls `c.set('props', …)` as the **single identity thread-point** for the whole `/api` surface; all routes and the scope gate read `c.get('props')` (never poke at `executionCtx` directly). Routes delegate to the identical service/coordinator layer:
  - `POST /api/quote` → `swapService.getQuote` (scope `swap:read`); quoted output returned in a form reusable as `expectedAmountOut`.
  - `POST /api/swap` → `SwapCoordinator.executeSwap`, awaits receipt bounded by `deadlineSeconds`; a receipt-wait timeout returns the row still `submitted` with `result: "timed_out"`. Input accepts the same optional **`expectedAmountOut`** floor and enforces the same drift/approval/rail semantics (scope `swap:write`). A `swap:read`-only token is **rejected** here.
  - `GET /api/transactions` → repository `list` (scope `swap:read`). **Pagination:** `?limit=` defaults to 20, capped at 100; `?cursor=` is the opaque integrity-protected `(createdAt, id)` cursor (tampered → `invalid_input`); response includes `nextCursor`.
  - `GET /api/transactions/:id` → repository `findById` (scope `swap:read`).
  - Errors serialized from the same `toErrorEnvelope` codes with matching HTTP status (`rate_limited` → 429, `approval_required` → 409/422, etc.).
- **Interface:** standard Hono handlers; JSON in/out.
- **Goals:** G4, G2, G9, G10.

### 5.13 Health — part of `publicApp`
- **Responsibility:** `GET /healthz` — unauthenticated liveness returning a **constant body** `{ status:"ok" }` with **no env/binding oracle** (it must not branch on env presence, so it cannot be used to probe configuration state); stays green even under placeholder/misconfigured bindings so liveness is distinguishable from misconfiguration.
- **Goals:** G1.

### 5.14 Docs (Diátaxis) — `docs/*`
- **Responsibility:** Authored via the writing-documentation skill:
  - **tutorial** — stand up locally, mint a token, run a mocked quote.
  - **how-to** — set secrets/bindings, **run the one-time USDC→Universal Router `approve`** (explicitly documented — G13), deploy, run smoke script.
  - **how-to (reconciliation runbook)** — **named deliverable (settled — Interview round 5):** `docs/how-to/reconcile-stranded-submitted.md`, a step-by-step runbook for reconciling any swap left in `submitted` status (e.g. after a receipt-wait `timed_out` result or a DO crash between submit and receipt): look up the recorded `txHash` on-chain, determine the tx's real outcome, and mark the row `confirmed` (with `actualAmountOut`/`gasUsed`) or `failed` (with `errorCode`) accordingly. **The runbook also notes that a `pending` row with no `txHash` (aborted before submission) is safe to mark `failed`** — no on-chain transaction exists for it.
  - **reference** — MCP tool schemas (including the optional `expectedAmountOut` floor, pagination cursor + `result` field), REST endpoints, `swaps` table columns + status lifecycle, the full error-code allowlist.
  - **explanation** — why OAuthProvider + McpAgent, why the `RateLimiter` DO over KV, why SwapCoordinator DO serialization, the drift-floor semantics (caller-supplied floor vs the API-embedded slippage floor), the `approval_required` no-auto-send stance, custodial-wallet trade-offs, and why `timed_out` is a call result rather than a row status.
- **Goals:** G13.

### 5.15 Smoke script — `scripts/smoke.ts`
- **Responsibility:** Manual, human-run real-chain verification via `tsx` against a deployed env: mints a token through the OAuth dance, runs a tiny real ETH→USDC quote+swap, prints the persisted row. Documents (and optionally performs) the one-time USDC approval for the USDC→ETH direction. **Not** part of the automated suite.
- **Goals:** G11.

### 5.16 package scripts — `package.json`
- **Responsibility:** `dev`, `deploy`, `test`, `typecheck`, `lint`, `format`, `cf-typegen`, `db:generate` (drizzle-kit), `smoke` (tsx). pnpm only.
- **Runtime deps:** `hono`, `agents`, `@modelcontextprotocol/sdk`, `@cloudflare/workers-oauth-provider`, `zod`, `drizzle-orm`, `viem@^2`. **Dev:** `wrangler`, `vitest@^4.1` (peer of the pool), `@cloudflare/vitest-pool-workers@^0.18` (0.18.4 indicative — pin whatever version exports `cloudflareTest()` with vitest ^4.1 peer at install time), `drizzle-kit`, `tsx`.
- **Goals:** G11, G12.

### 5.17 RateLimiter Durable Object — `src/ratelimit/RateLimiter.ts`
- **Responsibility:** The third DO class (wired into `wrangler.jsonc` `durable_objects.bindings` + `new_sqlite_classes`, §5.1). A single strongly-consistent counter authority for the passphrase gate (decision 25). Maintains, in DO storage:
  - a **per-IP failure count** with a rolling/expiring 10-minute window (keyed by `CF-Connecting-IP`), ceiling 5;
  - a **global failure count** with a rolling/expiring 10-minute window across all IPs, ceiling 20.
  Because a DO serializes its own requests, `checkAndConsume` increments are atomic and the ceilings genuinely hold under concurrent consent POSTs (unlike KV). Windows are **fixed-tumbling 10-minute windows** expiring lazily on read (stored window-start timestamps; no alarm handler required); successful auth does not count against either budget and resets the per-IP window (§5.6a).
- **Interface:** `checkAndConsume(ip): Promise<{ allowed: boolean; reason?: "per_ip" | "global" }>`; `recordSuccess(ip)`. Consumed by `POST /authorize` (§5.6a) before the passphrase compare.
- **Goals:** G2.

---

## §6 Test Strategy

**TDD is non-negotiable (G11):** each component is built **test-first** — write the failing test, implement to green, refactor. No implementation file is authored before its test.

**Vitest 4 setup:** the project uses **`@cloudflare/vitest-pool-workers` ^0.18 (current 0.18.4, peer `vitest ^4.1`)**. `defineWorkersConfig` (the old ≤0.13 API) is **not** used; instead the `cloudflareTest()` Vite plugin in `vitest.config.ts` with `wrangler: { configPath: "./wrangler.jsonc" }` and `miniflare.bindings.TEST_MIGRATIONS = await readD1Migrations("./drizzle")`; `setupFiles` applies them via `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`. **Storage is isolated per-test-file** — each test file gets a clean D1. Integration entry via `exports.default.fetch()` (preferred over deprecated `SELF`). DOs tested via stubs + `runInDurableObject()`.

**Multi-project layout:**
- **Node pool** — pure logic: `errors.classify` + envelope redaction, safety-rail validation, quote/amount math, env validation (incl. `TRADING_API_BASE_URL` host allowlist + secret-accessor shape), Zod schema shapes, **abort-on-drift comparison math (caller-floor and omitted-floor branches)**, **slippage units (percent↔fraction)**, **Trading API retry/backoff decision logic (which calls retry, 250ms→500ms jittered timing)**, **routing-shape assertion + routing-aware accessor**, **address-constants + native-sentinel assertion**, **cursor encode/decode + tampered-cursor rejection**, **log/envelope redaction (secret-name + long-hex) leak test**.
- **Workers pool** — runtime/DO: `SwapCoordinator` lifecycle transitions (mocked engine) **including abort-on-drift (both branches), approval_required abort, gas-headroom balance rail, receipt-wait timeout vs revert disambiguation, and pending→failed rail disposition**, repository against migrated D1 **including cursor pagination**, MCP tool handlers with injected deps, **`RateLimiter` DO counter behavior including concurrent attempts holding the ceiling (per-IP and global)**.
- **Integration project** — OAuth round-trips through `exports.default.fetch()`: a helper drives the `/authorize` CSRF+passphrase dance to **mint a real token**, then calls `/mcp` over JSON-RPC and `/api/*` over HTTP; includes the **CSRF-rejection path**, the **foreign-resource rejection path**, the **429-after-limit** throttle path, and the **read-only-token rejected by write paths** path.

**Mocked-chain fixture policy (decision 8):** all chain I/O is behind the injected `TradingApiClient` and `ViemSigner` interfaces. Tests inject fakes returning **recorded fixtures** — `/check_approval` (null and **non-null/approval-required** variants), `/quote` (CLASSIC/WRAP/UNWRAP and a **non-CLASSIC-family variant that must fail closed**), `/swap` response bodies, and a fake receipt (`status:"success"` / `"reverted"`) plus a **timeout-throw** variant. No network, no RPC in the automated suite. Rate-limit (429), drift (caller-floor + omitted), approval-required, receipt-timeout, and revert paths are exercised via fixture variants.

**Test-type × component matrix (every goal ≥1 test):**

| Component | Node | Workers | Integration | Goals |
|---|---|---|---|---|
| errors/classify + envelope + redaction leak test | ✓ | | ✓ | G10 |
| env validation (fail-closed, host allowlist, secret-accessor shape) | ✓ | | | G12,G10 |
| safety rails (slippage cap, deadline, balance>0) | ✓ | ✓ | | G6 |
| gas-headroom balance rail (ETH→USDC native+gas; USDC→ETH erc20+native gas) | ✓ | ✓ | | G6 |
| direction-aware balance source (getNativeBalance vs getErc20Balance, 18 vs 6 decimals) | ✓ | ✓ | | G5,G6 |
| abort-on-drift — caller-floor branch (fresh < expectedAmountOut × (1−tol) → `slippage_exceeded`, `failed` row, no tx) | ✓ | ✓ | | G6,G3 |
| abort-on-drift — omitted-floor branch (no drift abort; the API-embedded slippage floor from `slippageTolerance` on the re-quote is the only rail) | ✓ | ✓ | | G6,G3 |
| slippage units (percent to API, fraction in math) | ✓ | | | G5,G6 |
| approval gating (USDC→ETH: non-null /check_approval → `approval_required` abort, no swap, no approval tx sent) | ✓ | ✓ | | G6,G5 |
| Trading API client (fixtures, 8s timeout→`upstream_unavailable`, ≤2 jittered retries 250ms→500ms on /quote & /check_approval only, never /swap) | ✓ | | | G5 |
| routing-shape assertion (routing ∈ {CLASSIC,WRAP,UNWRAP} else `upstream_unavailable`; routing-aware accessor, never bare quote.output.amount) | ✓ | | | G5 |
| viem signer (fake receipt success/revert) | ✓ | ✓ | | G5 |
| receipt-wait disambiguation (timeout → stays `submitted`/`timed_out`; revert → `failed`/`swap_failed`; timeout never mapped to failed; no 5th status) | | ✓ | | G7,G8,G9 |
| rail/drift/approval failure disposition (pending→failed with errorCode, no txHash) | | ✓ | | G8 |
| swapService orchestration | ✓ | ✓ | | G3,G5,G6 |
| SwapCoordinator lifecycle + eager writes | | ✓ | | G7,G8,G9 |
| **G7 concurrency — two concurrent execute_swap serialized by in-DO promise-chain mutex; no overlapping submit; nonce order preserved** | | ✓ | | G7 |
| **G9 mid-swap interleaving — while `submitted`, get_transaction/GET :id returns `submitted` before the call returns** | | ✓ | ✓ | G9 |
| transactions repository (D1) | | ✓ | | G8,G9 |
| cursor pagination (default 20, max 100, opaque `(createdAt,id)`, stable nextCursor, **tampered-cursor rejected**) | ✓ | ✓ | | G3,G4 |
| address constants + native-ETH zero sentinel (== known-good checksummed) | ✓ | | | G5 |
| **`RateLimiter` DO (5 failed/IP/10min AND global 20/10min; CF-Connecting-IP only; concurrent attempts hold ceiling)** | | ✓ | ✓ | G2 |
| D1 schema/migrations | | ✓ | | G8 |
| MCP tools — **per-tool rows** (get_quote / execute_swap / list_transactions / get_transaction) via injected deps | | ✓ | ✓ | G3,G9,G10 |
| OAuth provider + passphrase consent | | | ✓ | G1,G2 |
| **consent CSRF (POST without valid token rejected; Origin/Referer allowlist)** | | | ✓ | G2 |
| **resource validation (foreign `resource` at consent rejected)** | | ✓ | ✓ | G2 |
| **constant-time compare (SHA-256 both sides then constant-time byte compare)** | ✓ | | | G2,G10 |
| **scope model — swap:read-only token rejected by execute_swap and POST /api/swap** | | ✓ | ✓ | G2,G10 |
| transport/audience/scope guards (`swap:read`/`swap:write`) | ✓ | ✓ | ✓ | G2,G10 |
| REST routes (4) + props-adapter middleware (c.executionCtx.props → c.set('props')) | | ✓ | ✓ | G4,G9 |
| healthz (constant body, no env oracle) | | | ✓ | G1 |
| reconciliation runbook + one-time-approval how-to present | | | ✓ | G13 |

**TDD ordering constraints:** (1) cross-cutting first — `errors` (+ redaction), `env` (+ host allowlist + secret accessors), `log` (+ redaction), `auth` guards, constant-time compare; (2) then `db/schema` + migrations + repository + cursor pagination (+ tampered-cursor) + address/sentinel constants — plus the **pure rails** (slippage cap, deadline, amount>0, drift math, slippage units) which need no chain seam; (3) then the engine clients (fixture-driven, incl. timeout/retry, routing-shape assertion, direction-aware balance reads) + swapService — and only here the **balance rail** (it depends on the `ViemSigner` seam introduced in this step, per M7); (4) then `SwapCoordinator` (depends on repository + engine; incl. both drift branches, approval gating, gas-headroom rail, receipt timeout-vs-revert, pending→failed disposition, and the G7 concurrency test); (5) then MCP tools + REST routes + props-adapter middleware (depend on coordinator + service); (6) then OAuth provider wiring + **`RateLimiter` DO** + CSRF + resource validation + integration token-mint helper; (7) docs (incl. one-time-approval how-to + reconciliation runbook) + smoke script last.

---

## §7 Acceptance Criteria

- **G1:** Default export is `OAuthProvider`; a request to `/mcp` and `/api/*` without a valid bearer is rejected; `/healthz` returns `200 {status:"ok"}` unauthenticated with a **constant body that does not branch on env**; provider well-knowns resolve. *(integration)*
- **G2:** Submitting the correct passphrase to `/authorize` (with a valid CSRF token and allowed Origin) mints a token; wrong passphrase re-renders with an error and mints nothing; **a POST without a valid CSRF token is rejected before the passphrase is evaluated**; **a consent request whose client-supplied `resource` ≠ `CANONICAL_MCP_URI` is rejected**; the minted token's props carry `userId = SINGLE_USER_ID`, scopes `["swap:read","swap:write"]`, `resource = CANONICAL_MCP_URI`, **and no secret**; both `/mcp` and `/api` accept it; the passphrase compare is **SHA-256-then-constant-time**; **after 5 failed attempts from one IP (or 20 globally) within 10 minutes, the next returns HTTP 429 (`rate_limited`) without evaluating the passphrase, enforced by the strongly-consistent `RateLimiter` DO (ceiling holds under concurrent attempts; IP from `CF-Connecting-IP` only); a subsequent success is possible once the window expires**; **a `swap:read`-only token is rejected by every write path**. *(integration + workers)*
- **G3:** `get_quote` returns a quoted output without writing D1, in a form directly reusable as `expectedAmountOut`; `execute_swap` returns a terminal `confirmed`/`failed` result with `txHash`, `actualAmountOut`, `gasUsed`, `transactionId`; **when the caller supplies `expectedAmountOut` and the fresh re-quote drifts below `expectedAmountOut × (1 − tolerance)`, the swap is aborted with `slippage_exceeded`, writes a `failed` row (no `txHash`), and sends no transaction; when `expectedAmountOut` is omitted, no drift abort fires and the API-embedded slippage floor (from `slippageTolerance` on the re-quote) is the only price rail**; a **missing USDC→ETH approval aborts `approval_required`** (no swap, no approval tx); when the receipt wait exceeds `deadlineSeconds` the row **remains `submitted`** with `txHash` set and result `timed_out` (**no fifth status**); a **revert** yields `failed`/`swap_failed`, distinct from timeout; `list_transactions` and `get_transaction` return persisted rows; `list_transactions` honors default `limit` 20, max 100, an opaque `(createdAt,id)` cursor returning a stable `nextCursor`, and **rejects a tampered cursor**. *(workers + integration)*
- **G4:** Each REST route returns the same payload shape as its MCP counterpart and enforces the same scope (read-only token rejected by `POST /api/swap`); `POST /api/swap` accepts the optional `expectedAmountOut` floor and awaits the receipt (bounded by `deadlineSeconds`, timeout → `submitted` + `result: "timed_out"`); identity reaches routes via the props-adapter middleware; `GET /api/transactions` paginates with the same default-20/max-100 opaque cursor and returns `nextCursor`. *(integration)*
- **G5:** With fixture responses, the engine issues `EXACT_INPUT` quotes with `routingPreference:"CLASSIC"`, chain ids as `"1"`, native-ETH zero sentinel; **`/quote` routing is asserted ∈ {CLASSIC,WRAP,UNWRAP} (else `upstream_unavailable`) and output is read via a routing-aware accessor**; `/swap` body is spread (not nested) with null permit fields stripped; a per-call timeout of 8s maps to `upstream_unavailable`; `/quote` and `/check_approval` retry at most twice with jittered backoff (250ms→500ms) while `/swap` never retries; **balance reads are direction-aware (native vs USDC `balanceOf`, 18 vs 6 decimals) with gas headroom for ETH→USDC**; viem submits to Universal Router and resolves on receipt (success vs revert distinguished); **a unit test asserts each embedded mainnet address (USDC, WETH9, Universal Router, Permit2) and the native-ETH zero sentinel equals its known-good checksummed constant.** *(node + workers)*
- **G6:** A swap with `slippageTolerancePct > 5` is rejected `invalid_input`; missing slippage defaults to 0.5 (percent to API, fraction in math); `amountIn ≤ 0` rejected; `amountIn > balance` (direction-aware, gas-headroom-aware) rejected `insufficient_balance`; deadline defaults to 1200s; **with a caller `expectedAmountOut`, a fresh re-quote drifting below its floor aborts `slippage_exceeded` before any submission**; a missing USDC→ETH approval aborts `approval_required` before submission. *(node + workers)*
- **G7:** Two concurrent `execute_swap` calls are serialized by the DO's **in-DO promise-chain single-flight mutex** (not `blockConcurrencyWhile` per request); no overlapping submit; nonce order preserved. *(workers — dedicated row)*
- **G8:** A completed swap yields exactly one `swaps` row transitioning `pending→submitted→confirmed`; a reverted swap yields a `failed` row with `errorCode = swap_failed` and `txHash`; a drift/approval/rail abort yields a `failed` row with its `errorCode` and **no `txHash`** (`pending→failed`); a receipt-wait timeout leaves the row `submitted` (never a fifth status) with `txHash` persisted; all persist their lifecycle columns. *(workers)*
- **G9:** While a swap is `submitted`, `get_transaction`/`GET /api/transactions/:id` returns `status:"submitted"` **before** the `execute_swap` call returns — a dedicated interleaving test proves eager writes drive live visibility mid-swap. *(workers + integration)*
- **G10:** No caller-facing error contains a raw upstream/internal message; every error `code` is a member of the closed allowlist (`quote_expired` is absent; `approval_required` is present); a **leak test** confirms `log()` and `toErrorEnvelope()` redact secret-name fields and long hex. *(node + integration)*
- **G11:** `pnpm test` passes with zero real network/RPC calls; `pnpm typecheck` clean; `scripts/smoke.ts` exists and is documented as manual-only.
- **G12:** `wrangler.jsonc` contains only placeholder ids/secrets and **`nodejs_compat` explicitly uncommented**; no real key/id committed; `pnpm cf-typegen` succeeds.
- **G13:** `docs/` contains one artifact per Diátaxis quadrant covering setup, OAuth dance, swap flow, and data model, **plus the one-time USDC-approval how-to and a named reconciliation runbook how-to (`docs/how-to/reconcile-stranded-submitted.md`) — which also notes that `pending` rows with no `txHash` are safe to mark `failed`.** *(integration presence check)*

---

## §8 Resolved Decisions

| Decision | Authorising source | Rationale |
|---|---|---|
| Custodial single hot wallet, key as Worker secret `SWAP_PRIVATE_KEY` | Interview 1 | POC; no co-signer; one wallet ↔ one DB user. |
| Self-contained passphrase consent (`AUTH_PASSPHRASE` secret), SHA-256-then-constant-time compare | Interview 2 + round 6 | No third-party IdP; single operator gate; timing-safe. |
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
| **Quote-drift → abort with `slippage_exceeded`** (failed row, no tx) | Interview round 5 | Caller safety on an irreversible money-moving op. |
| **OAuth two-scope model `swap:read` + `swap:write`**, co-granted (no runtime boundary today, honest) | Interview round 5 | Future read-only token with no code change; gate still enforced. |
| **`/authorize` rate limit: 5 failed / IP / 10 min → 429** *(policy stands; backend amended below)* | Interview round 5 | Brute-force defense on the sole credential gate. |
| **Receipt-wait bound = `deadlineSeconds` (1200s); timeout → row stays `submitted`, result `timed_out`** (status enum unchanged) | Interview round 5 | Caps request duration; minimal state machine; surfaces reconciliation without a fifth status. |
| **Trading API 8s timeout → `upstream_unavailable`; ≤2 jittered retries (250ms→500ms) for `/quote` + `/check_approval` only; never `/swap`/submitted txs** | Interview round 5 | Fail fast within Worker limits; no double-submission on money path. |
| **Pagination: opaque, integrity-protected cursor over `(createdAt, id)`; default 20, max 100** | Interview round 5 | Stable under concurrent inserts; bounded page size; tamper-resistant. |
| **Reconciliation runbook (docs how-to)** for swaps stranded in `submitted` | Interview round 5 | Operator can recover `timed_out`/crash-stranded swaps from on-chain state. |
| **Drift floor: optional caller-supplied `expectedAmountOut`** — if supplied, abort `slippage_exceeded` when fresh < `expectedAmountOut × (1 − tol)`; if omitted, fresh re-quote is baseline and the API-embedded slippage floor (from `slippageTolerance`) is the only rail | **Interview round 6** | Fixes v2's undefined baseline (B1) and slippage double-count (B2); caller opts in to a hard floor. |
| **DCR posture: open `/register` + hardened consent** — CSRF token bound to AuthRequest, prominent client-name + exact redirect_uri display, strict redirect_uri validation, resource-param validation | **Interview round 6** | Claude connector needs open DCR; consent hardening + operator eyeballing bound the phishing surface (B4/B5/M12). |
| **`RateLimiter` Durable Object (strongly consistent):** 5 failed/IP/10min AND global 20 failed/10min; IP from `CF-Connecting-IP` only — **AMENDS the round-5 KV rate-limit decision** | **Interview round 6** | KV can't enforce a ceiling (no atomic increment, eventual consistency); DO serialization makes the ceiling real; global budget resists IP rotation (B6). |
| `routingPreference: "CLASSIC"` + **routing-shape assertion (∈ {CLASSIC,WRAP,UNWRAP} else `upstream_unavailable`) + routing-aware output accessor** | Research B + round-6 review | Verified Trading API shape; CLASSIC request does not guarantee CLASSIC response (B3). |
| One-time legacy USDC→Universal Router `approve` (no per-swap Permit2); **coordinator never auto-sends it — missing approval aborts `approval_required`** | Research B + M4 | Backend service pattern; never move funds via an implicit approval. |
| `OAuthProvider` default export; **`SwapMcpAgent.serve("/mcp")` (no `{binding}`)** streamable HTTP; `OAUTH_KV`; `new_sqlite_classes` for all three DOs | Research A + C + M8 | Required for Claude connector discovery + DCR; McpAgent = SQLite DO; correct apiHandlers overload. |
| **REST props threading via explicit adapter middleware** (`c.executionCtx.props` → `c.set('props',…)`) | Research A + M9 | OAuthProvider does not thread props into Hono automatically. |
| **`@cloudflare/vitest-pool-workers` ^0.18 (0.18.4, peer vitest ^4.1)**; `cloudflareTest()` plugin; `applyD1Migrations`; per-file isolation; `exports.default.fetch()` | Research C + B7 | The `cloudflareTest()` API belongs to ^0.18, not 0.13. |
| Closed `ErrorCode` allowlist (`quote_expired` removed, `approval_required` added) + `classify()` + **enforced redaction in `log()`/`toErrorEnvelope()`; secrets behind accessors, never in `ValidatedEnv`** | Research A + M11 | Security/consistency of caller-facing errors; no secret leakage. |

---

## §9 Open Questions

**None — all decisions authorised through interview rounds 1–6.** Every product/security fork previously flagged (quote-drift baseline, OAuth scope granularity, `/authorize` rate-limit backend, DCR posture / CSRF, receipt-wait bound, Trading API timeout/retry, routing-shape assertion, approval gating, pagination integrity, reconciliation runbook) has been answered by the human across Interview rounds 1–6 and moved to §8 as a resolved decision. No item is pending; implementation may proceed against every section as settled.

---

## §10 Risks

- **Hot-wallet key exposure.** `SWAP_PRIVATE_KEY` in a Worker secret + custodial signing is the highest-value target. *Mitigation:* key only ever materialized inside `SwapCoordinator` via a secret **accessor** (never a plain `ValidatedEnv` field, never in props, never logged — enforced redaction in `log()`/`toErrorEnvelope()`, leak-tested); per-request viem client; single wallet; POC-scoped funds; the sole passphrase gate is CSRF-protected, timing-safe (SHA-256 + constant-time), and rate-limited by a strongly-consistent DO (5 failed/IP/10min + global 20/10min → 429). Residual risk accepted per decision 1.
- **Consent phishing / open DCR.** `/register` is open (Claude connector requires it), so an attacker can register a client and drive the operator to `/authorize`. *Mitigation (decision 24):* a **single-use CSRF token bound to the AuthRequest** + Origin/Referer allowlist blocks cross-site form submission; **strict `redirect_uri` validation** + **prominent display of the requesting client name and exact redirect_uri** let the operator refuse an unexpected grant; the **passphrase remains the hard gate** — registration alone yields nothing. **Recorded risk model:** attacker can register but cannot pass consent without the passphrase and the operator eyeballing the URI.
- **Rate-limit ceiling correctness.** A KV counter could not enforce the 5/IP/10min ceiling (no atomic increment, cross-colo eventual consistency, IP-rotation bypass, CGNAT lockout). *Mitigation (decision 25):* the **`RateLimiter` Durable Object** serializes increments so both the per-IP (5/10min) and **global (20/10min)** budgets genuinely hold, even under concurrent attempts (tested); IP is taken only from trusted `CF-Connecting-IP`. Global budget bounds IP-rotation attacks; per-IP + global together trade a small CGNAT-false-positive risk for a real ceiling (POC-accepted).
- **Trading API shape/availability drift.** The `/quote`/`/swap` response contracts can change or return a non-CLASSIC routing shape; the gateway can 429/5xx. *Mitigation:* client isolated behind `TradingApiClient`; **routing asserted ∈ {CLASSIC,WRAP,UNWRAP} (else fail closed `upstream_unavailable`) and output read via a routing-aware accessor — never a bare `quote.output.amount`**; fixtures pin the expected shape (drift breaks a test, not prod silently); 8s per-call timeout + ≤2 jittered retries (idempotent calls only, 250ms→500ms); `/swap` never retried.
- **Wrong contract address (fund-loss).** A single wrong hardcoded mainnet address (USDC, WETH9, Universal Router, Permit2) or a wrong native sentinel on a custodial wallet is a direct fund-loss vector. *Mitigation:* addresses + native-ETH zero sentinel are named exported constants covered by a **dedicated unit test asserting each equals its known-good checksummed value**, so any accidental edit fails CI before deploy; addresses are never caller-supplied.
- **Drift-floor semantics.** A caller who never quotes has no preview, and applying the router's own tolerance twice would make a drift guard a near-no-op. *Mitigation (decision 23):* the drift floor is an **optional caller-supplied `expectedAmountOut`** — supplied → hard abort `slippage_exceeded` below `expectedAmountOut × (1 − tol)`; omitted → no double-count, the API-embedded slippage floor (from `slippageTolerance` on the re-quote) is the single price rail. `get_quote` surfaces its output ready to reuse as the floor.
- **Missing USDC→ETH approval.** Without the one-time `approve`, a USDC→ETH swap would revert (burning gas), and auto-sending an approval would move funds implicitly. *Mitigation (M4):* `/check_approval` runs **before** `/swap`; a non-null approval **aborts `approval_required`** with a `failed` row and **no transaction of any kind** — the coordinator never sends the approval; the operator runs it out-of-band (how-to + smoke script).
- **Receipt-wait timeout vs revert confusion.** viem `waitForTransactionReceipt` throws on both; mis-mapping a timeout to `failed` would corrupt lifecycle accounting. *Mitigation (M3):* the coordinator branches on `WaitForTransactionReceiptTimeoutError` (→ stays `submitted`/`timed_out`) vs revert (→ `failed`/`swap_failed`); a timeout is never written `failed`.
- **DO/eager-write consistency + stranded `submitted`.** If the DO crashes between submit and receipt, or the receipt wait times out at `deadlineSeconds`, a row is left in `submitted` with `txHash` recorded (call result `timed_out`). *Mitigation:* eager write of `submitted` + `txHash` makes the tx recoverable from chain; the **named reconciliation runbook** (`docs/how-to/reconcile-stranded-submitted.md`) gives the operator a step-by-step (and notes `pending` rows with no `txHash` are safe to mark `failed`). The in-DO promise-chain mutex prevents nonce collisions. POC accepts manual recovery.
- **Placeholder bindings block deploy.** Deploying with placeholder D1/KV/DO ids or unset secrets will fail at runtime. *Mitigation:* documented in the how-to; `validateEnv` fails closed with a clear `internal` error (and pins the `TRADING_API_BASE_URL` host) rather than a confusing chain error; `/healthz` stays green with a constant body (no binding/env oracle) so liveness is distinguishable from misconfiguration.
- **vitest-pool-workers version.** Using the wrong pin (`0.13`) would yield the removed `defineWorkersConfig` API and contradict the `cloudflareTest()` setup. *Mitigation:* pinned to **`@cloudflare/vitest-pool-workers@^0.18` (0.18.4, peer `vitest@^4.1`)** in `package.json`; setup uses `cloudflareTest()` + `applyD1Migrations`.
- **Rate limit / connection ceiling (Trading API).** Trading API ~10 req/s and Workers' 6-simultaneous-outgoing-connection limit can throttle bursts. *Mitigation:* DO serialization caps swap concurrency to one; 8s timeout + ≤2 jittered retries on idempotent calls only.