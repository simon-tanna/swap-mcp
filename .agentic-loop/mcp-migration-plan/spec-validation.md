# spec-validation.md — validating-specs merged report (spec v2)

Run: 4 parallel spec-design-validator instances (lenses: scope, domain, architecture, security). Tooling: swap-integration, viem-integration, cloudflare:build-mcp, cloudflare:cloudflare skills + context7 + Cloudflare docs MCP. Findings deduplicated and reconciled by the controller.

## 1. Executive Summary

The spec is structurally excellent — full decision traceability to five interview rounds, a genuine TDD matrix, honest risks — but seven fixable Blockers must be resolved before implementation: the abort-on-drift guard has no defined baseline and double-counts slippage; the Trading API response shape is assumed rather than asserted; the OAuth consent form lacks CSRF protection; dynamic client registration is left open by default; the KV-based rate limit cannot enforce its own ceiling; and the vitest-pool-workers version pin ("v0.13") is factually wrong for the API the spec itself describes. **REVISE.**

## 2. What's Strong (earned)

- Decision traceability: every §8 entry maps to a literal interview authorisation or verified research; §0's decision map is genuinely complete (scope + structured reviewer both confirmed).
- The Trading API contract details in §5.9 (headers, string chain ids, native-ETH zero sentinel, spread `/swap` body, null-permit stripping, Universal Router address) match the swap-integration skill exactly (domain lens verified).
- The DO+D1 topology is platform-sound: McpAgent `this.env`/`this.props` usage, DO wall-time limits vs the 1200s wait (unlimited while caller connected; degrade-to-`timed_out` is the correct mitigation), wrangler/cf-typegen flow consistent with the scaffold (architecture lens verified against CF docs).
- workers-oauth-provider props encryption claim is accurate (AES-256 per-grant key, hashed tokens) and props content (userId/scopes/resource only) is the right call (security lens verified).

## 3. Blockers (all fixable)

- **B1 · domain · §5.7/§5.8** — Abort-on-drift has no baseline: `execute_swap` input carries no preview link (no quoteId/expected-output field), so "fresh vs caller's preview" is undefined for callers that never quoted. Fix: define the baseline explicitly (human decision — see open forks).
- **B2 · domain · §5.8 step 3** — Drift math double-counts slippage: comparing fresh output to `preview × (1 − slippageTolerance)` with the same tolerance the router already enforces on-chain makes the guard a near-no-op. Fix: separate drift bound or caller-supplied floor (same fork as B1).
- **B3 · domain · §5.9** — `routingPreference:"CLASSIC"` does not guarantee a CLASSIC response shape; reading `quote.output.amount` unguarded can throw if UniswapX routing returns. Fix: assert `response.routing ∈ {CLASSIC, WRAP, UNWRAP}` after `/quote`, else fail closed `upstream_unavailable`; routing-aware output accessor.
- **B4 · security · §5.6** — `POST /authorize` consent form has no CSRF protection (provider explicitly leaves consent-form handling to the app). Fix: single-use CSRF token bound to the parsed AuthRequest (KV/HMAC, short TTL), verified before passphrase evaluation; Origin/Referer check; integration test.
- **B5 · security · §5.6** — Dynamic client registration open by default: anyone can register a client/redirect_uri and drive the operator to /authorize (phishing/consent surface). Fix: decide DCR posture explicitly (human decision — see open forks); at minimum strict redirect_uri validation + consent screen displaying the requesting client.
- **B6 · security · §5.6/decision 18** — KV cannot enforce the 5/IP/10min ceiling: no atomic increment (parallel attempts under-count), eventual consistency across colos; per-IP keying is bypassable (IP rotation) and a lockout hazard (CGNAT). Fix: strongly consistent counter (Durable Object) + a global failed-attempt budget in addition to per-IP; trusted CF-Connecting-IP only (human confirmation — see open forks, since it amends authorised decision 18).
- **B7 · architecture · §6/§8/§10** — Version pin factually wrong: the `cloudflareTest()` API the spec describes belongs to `@cloudflare/vitest-pool-workers` ^0.18 (current 0.18.4, peer vitest ^4.1), not "v0.13". Pinning 0.13 would yield the old `defineWorkersConfig` API and contradict the spec's own setup. Fix: replace every "v0.13" reference with ^0.18.

## 4. Major Concerns

- **M1 · domain** — Balance rail lacks gas headroom for ETH→USDC (`amountIn + gasLimit×maxFee + buffer ≤ balance`).
- **M2 · domain** — `ViemSigner.getBalance` is direction-wrong for USDC→ETH: needs ERC-20 `balanceOf(USDC)` (6 decimals), not native `getBalance`.
- **M3 · domain** — viem `waitForTransactionReceipt` throws on BOTH timeout and revert; coordinator must branch on `WaitForTransactionReceiptTimeoutError` (→ stay `submitted`/`timed_out`) vs revert (→ `failed`), or timed-out txs get mis-written `failed`.
- **M4 · domain+scope** — Missing-approval path (USDC→ETH): `/check_approval` returning non-null approval must abort without submitting, with a defined code (e.g. new `approval_required`), never auto-send the approval tx; absent from §5.8 lifecycle and §7 acceptance.
- **M5 · scope** — G7 (DO serialization) has no dedicated test-matrix row; the nonce-safety claim — the DO's whole justification — is untested as specced. Add concurrency row + name the serialization primitive (in-DO promise-chain mutex, not blockConcurrencyWhile).
- **M6 · scope** — Rail-failure row disposition unspecified: a balance/slippage-rejected swap after the `pending` insert — `failed` row (which code) or delete? Reconcile with G8's row-count claim; add `pending→failed` to the lifecycle assertion.
- **M7 · scope** — TDD ordering buildability: balance rail depends on the ViemSigner seam introduced a step later; split pure rails (step 1–2) from balance rail (step 3).
- **M8 · architecture** — `SwapMcpAgent.serve("/mcp", { binding })` is the wrong overload for the OAuthProvider apiHandlers form; use `.serve("/mcp")` and verify against installed agents types.
- **M9 · architecture** — REST props threading doesn't exist as assumed: OAuthProvider puts props on `ctx.props`; Hono needs an explicit adapter middleware reading `c.executionCtx.props` → `c.set('props', …)`.
- **M10 · security** — Constant-time compare underspecified: hash both sides (SHA-256) then constant-time byte compare; never raw-string compare.
- **M11 · security** — Secret redaction must be enforced, not conventional: `log()`/`toErrorEnvelope()` redaction pass (secret-name patterns + long hex); keep secrets out of the passed-around ValidatedEnv shape; leak test.
- **M12 · security** — Audience check is a tautology unless the client-supplied `resource` in the authorize request is validated against CANONICAL_MCP_URI at consent time.
- **M13 · security** — Scope split provides no runtime privilege boundary today (both scopes co-granted); state this honestly + test that a swap:read-only token is rejected by write paths.

## 5. Minor Issues & Nits (batch into v3)

- Mid-swap live-visibility (G9) needs its own interleaving test row; per-tool test-row granularity for the 4 MCP tools; env-validation fail-closed criterion; `quote_expired` code is unreachable — remove or define its emitting path; add zero-address native sentinel to the address-constants test; slippage units test (percent to API, fraction in math); pin `TRADING_API_BASE_URL` host allowlist in validateEnv (API-key egress); healthz constant-body (no env oracle); HMAC/validate the pagination cursor (tampered-cursor rejection test); non-goals additions (no token refresh/revocation customization; no queue beyond DO single-flight); `nodejs_compat` must be explicitly uncommented (viem); `getProps` must be a live thunk `() => this.props`, deps captured at init must be request-invariant; note that the 1200s ceiling is client-transport-bound; retry delays state attempt-1=250ms, attempt-2=500ms; props must never contain secrets (explicit assertion); G13 how-to must document the one-time USDC approval; runbook: `pending` rows with no txHash are safe to mark failed.

## 6. Unstated Assumptions

- A preview quote exists whenever execute_swap runs (false — B1).
- CLASSIC request ⇒ CLASSIC response (unverified — B3).
- KV counters are atomic (false — B6).
- OAuthProvider threads props into Hono automatically (false — M9).
- One `getBalance` fits both directions (false — M2).

## 7. Missing Elements

- Concurrency/serialization test row (M5); missing-approval acceptance criterion (M4); mid-flight visibility test row; CSRF + DCR posture (B4/B5); rail-failure row-state rule (M6).

## 8. Codebase & Convention Conflicts

- wrangler scaffold ships `nodejs_compat` commented out — spec must state it gets enabled. Otherwise §5.1 is consistent with the scaffold and the existing `cf-typegen` script (verified).

## 9. Recommended Next Steps

1. Human decides the three open forks: (a) drift baseline design (B1/B2), (b) DCR posture (B5), (c) rate-limit backend amendment to decision 18 (B6).
2. Planner folds all Blockers + Majors + the Minor batch into spec v3.
3. Re-run structured review + validating-specs; expect GO.

## 10. Final Verdict

**REVISE** — seven fixable Blockers (guard semantics, response-shape assertion, CSRF, DCR, rate-limit backend, version pin); rework is spec-text only, est. one revision cycle before implementation can safely start.
