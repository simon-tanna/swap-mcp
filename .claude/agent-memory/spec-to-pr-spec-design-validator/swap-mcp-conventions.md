---
name: swap-mcp-conventions
description: Verified Cloudflare-platform facts for validating the swap-mcp mcp-migration-plan spec (vitest-pool-workers API, DO topology, OAuthProvider).
metadata:
  type: project
---

# swap-mcp mcp-migration-plan — verified platform facts

Spec lives at `.agentic-loop/mcp-migration-plan/spec.md`. Interview answers in `interview-log.md` are literal authorisations — verify ENCODING, do not relitigate settled decisions.

**Verified against Cloudflare docs (2026-07):**
- `@cloudflare/vitest-pool-workers` current API uses the `cloudflareTest()` Vite plugin (in `plugins:[]` alongside `defineConfig` from `vitest/config`), NOT the removed `defineWorkersConfig`/`defineWorkersProject`. `readD1Migrations(path)` + `applyD1Migrations(db, migrations)` + `wrangler:{configPath}` + per-file storage isolation + `runInDurableObject` are all correct. NB: CF migration-guide JSON-LD labels the Vitest-4 line "v0.13.x"; the spec pins "^0.18 (0.18.4)". The API surface is right; the exact minor-version number is the only unconfirmed detail.
- Three DO classes in this design: `SwapMcpAgent` (McpAgent SQLite DO), `SwapCoordinator` (nonce-serialization mutex), `RateLimiter` (strongly-consistent auth throttle). All three must appear in wrangler `durable_objects.bindings` + `migrations.new_sqlite_classes`.
- `SwapMcpAgent.serve("/mcp")` (no `{binding}` arg) is the correct overload for the OAuthProvider `apiHandlers` form.
- workers-oauth-provider does NOT thread props into Hono automatically — needs adapter middleware reading `c.executionCtx.props` → `c.set('props')`. It also leaves consent-form handling (incl. CSRF) to the app.
- **VERIFIED (2026-07, CF securing-mcp doc + workers-oauth-provider README):** props are **end-to-end encrypted using the access token as key material**; the library exposes **NO documented seam to inject token props directly**. This makes T32's `mintTestToken({scopes})` "write props directly through the OAuthProvider test seam/KV" claim UNVERIFIED — the plan asserts a seam the library docs do not describe. Only defensible negative-scope path is the app-owned `getProps` fake at the registrar/DO seam (already present in T22/T24 unit tests). Flag: the integration-level read-only-token coverage (T32) may not be buildable as written.
- **CF securing-mcp guide** recommends CSRF via a `__Host-` Secure/SameSite cookie bound to browser session. Spec §5.6 permits KV-nonce-bound-to-AuthRequest as an alternative, so T29 is spec-sanctioned — BUT KV nonce binds to a hash of AuthRequest fields, NOT session/cookie: with open DCR any party can drive the same AuthRequest and fetch a live CSRF token. Origin/Referer allowlist is the real cross-site defense; the CSRF token only blocks blind replay. Defense-in-depth gap vs CF guidance.
- **workers-best-practices canonical rule:** secret compare = `crypto.subtle.timingSafeEqual()` on fixed-size hashes. Plan T6 hand-rolls a byte compare after SHA-256 — defensible (digests fixed 32 bytes, no length leak) but deviates from platform primitive.
- **CF securing-mcp guide** warns MCP SDK <1.26 shares one McpServer across requests → cross-client response leakage. Pin @modelcontextprotocol/sdk ≥1.26 (plan leaves it unpinned in T1).

**Recurring spec strength:** full decision→section traceability via numbered interview rounds; honest scope-model statement (co-granted scopes = no runtime boundary today).

**Plan.md (34-task TDD plan) scope-audit findings (2026-07):**
- Plan has its own "Spec Coverage Map" + "Self-review checklist" claiming "no gaps" — audit it, do not trust it. It is mostly accurate but claims goals covered by tasks that only assert them at UNIT level when the AC says *(integration)*.
- G2 AC says "a subsequent success is possible once the window expires" AND "both /mcp and /api accept it". T28 covers window-expiry at DO unit level; T31/T32 integration never re-mints after a 429 window expiry — the "success after expiry" clause has no integration assertion (unit-only). Minor.
- G9 AC is dual-surface *(workers + integration)*: "get_transaction/GET /api/transactions/:id returns submitted before execute_swap returns". T21 proves it workers-side for get_transaction only; no INTEGRATION-level interleaving test and the GET /api/transactions/:id (REST) mid-swap path is never asserted. Coverage matrix row 291 claims both surfaces but plan tasks only deliver workers+MCP.
- Docs (T33): fs-presence/grep test only — matches G13's own "presence check" AC, so NOT a gap against the AC as written even though it asserts nothing about doc quality.

**Plan.md EXECUTION-lane findings (2026-07, verified vs CF docs):**
- Incremental DO-binding strategy (T18/T24/T28) is BOOT-SAFE in vitest-pool-workers: miniflare applies migrations fresh from the FINAL config each boot; single `tag:"v1"` array mutated across tasks is legal locally. Only matters for real `wrangler deploy` (migrations atomic/tag-once), which this plan never does. Not a blocker.
- CF docs current example imports `readD1Migrations`+`cloudflareTest` from package ROOT `@cloudflare/vitest-pool-workers`; older `/config` subpath still on the config-ref page. Plan T8 (line 345) doesn't pin the subpath. Low risk, resolve at install.
- T14 fake-timers retry test runs in NODE pool — no workers-runtime timer incompatibility.
- Real execution risks found: (1) T1 Step 3 agents `.d.ts` check has no fail-branch — if `serve()` needs `{binding}`, it strands T24/T31 with no plan. (2) T2 asserts `env.DB.prepare("SELECT 1")` but D1 migration wiring (TEST_MIGRATIONS/setupFiles) doesn't land until T8 — SELECT 1 needs no table so it passes, but the ordering is tight. (3) T18/T20/T21 all edit SwapCoordinator.ts + swapService.ts and depend on T18; T20&T21 both branch from T18 — merge-order coupling if run parallel. (4) T19/T32 "deliberate-inversion" is NOT real TDD red (inverting an assertion tests the test, not absent behavior) — sanctioned by plan but violates Iron Law letter; acceptable ONLY because these are breadth-proofs over already-built behavior.

**Plan.md ARCHITECTURE-lane findings (2026-07, verified vs CF docs + agents SDK context7):**
- OAuthProvider `apiHandlers:{ "/mcp": SwapMcpAgent.serve("/mcp") }` NO `{binding}` arg = CONFIRMED correct (CF agent-api docs + /cloudflare/agents). The build-mcp skill Quick Ref `serve("/mcp",{binding})` is the NON-OAuth standalone default-export form; do not conflate. research-stage2 + plan are right; the T1-Step3 `.d.ts` check is belt-and-suspenders.
- Multiple apiHandlers keys (/mcp McpAgent + /api Hono app) is standard. Hono app is a valid ExportedHandler for the /api key. T31 wraps it as a per-request `{ fetch }` calling `createApiApp(buildDefaultApiDeps(env))` — sound; keeps no cross-request state (workers-best-practices: no module-level request state — OK).
- SwapMcpAgent DO binding name = class name (PascalCase) intentionally ≠ SWAP_COORDINATOR/RATE_LIMITER SCREAMING_SNAKE; `.serve()` looks up its DO by class name. T24 flags "must NOT be fixed for consistency". Correct, non-obvious — do not report as inconsistency.
- DI pattern is coherent: services are pure (deps injected), DOs build `createDefaultDeps(this.env)` lazily (this.env not env — correct for `extends DurableObject<CloudflareBindings>`), MCP tools get `getProps:()=>this.props` LIVE thunk (never init-captured — matches McpAgent props semantics). props threading for REST needs adapter middleware (c.executionCtx.props→c.set) — plan T25 has it.
- File structure (40 files) is layered with NO circular imports: errors/log/env (leaf) → auth/db/repository/engine → services → coordinator(DO) → mcp+api → oauth → index. Each file created once, later-modified by design (plan enumerates the 7 multi-touch files). No responsibility split across modules sharing mutable state.
- `#tail` in-memory mutex (T21) cleared by DO hibernation/eviction — accepted limitation (D1 is source of truth; fresh cold DO = fresh chain). Not a bug.
- G12 `nodejs_compat` required for viem on Workers — plan T2 uncomments it. Correct.
