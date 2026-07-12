# plan-validation.md — validating-specs merged report on plan.md (iteration 2 — FINAL)

## Iteration 2: fix-verification result → GO

Two parallel spec-design-validator instances (security+scope; domain+execution+architecture) verified the fix pass. **Every prior finding — the Blocker (mintTestToken KV-injection replaced by workers-pool getProps-seam tests against the real registrar + real route), all 6 Majors (rail-after-buildSwap incl. spec v3.2 §5.8 renumber, ReceiptOutcome `unknown` branch, G9 REST integration half, transport-guard/audience wiring assertions, leak-channel coverage, T1 oracle + T19/T32 relabel), and the full minor batch — is VERIFIED-FIXED with cited line evidence.** The controller's T6 workers-pool placement was independently confirmed correct and boot-safe at its sequence position. Fresh-eyes sweeps found zero new blockers/majors — only 3 non-blocking traceability nits, 2 of which the controller applied (helpers gloss reword; scope-seam.test.ts added to the created-once inventory) and 1 needing no change (G9 row accurate as written). Spec v3.2's renumbering is contiguous with no stale references; tasks.json parses and matches the plan.

**Final verdict: GO** — zero blockers, zero majors, plan-review.md verdict approved with empty critical/important. The plan is locked; implementation can start.

---

# Iteration 1 report (historical — all findings below now VERIFIED-FIXED)

Run: 5 parallel spec-design-validator instances (execution, scope, architecture, security, domain — disjoint lenses) on plan.md (34 tasks), grounded in spec v3.1, interview-log decisions 1–26, research-stage2.md, and the live scaffold. Controller synthesis below.

## 1. Executive Summary

The plan is structurally excellent — genuine red-first TDD sequencing with truthful expected-failure modes, acyclic dependencies verified at every spot-check, one-green-commit granularity, clean leaf→root layering across 40 files, zero scope creep, and every import/config incantation matching the verified current package APIs. But one security Blocker and six reconciled Majors must be fixed before coding starts: the T32 `mintTestToken` KV props-injection helper is unbuildable (workers-oauth-provider encrypts props with the access token as key material — no injection seam exists, and forcing one would be a backdoor); the gas-headroom rail is sequenced before `buildSwap`, its only source of `gasLimit`; `ReceiptOutcome` has no branch for non-timeout throws; G9's REST-surface mid-swap-visibility AC has no integration assertion; the MCP transport-guard/audience wiring is asserted in prose but tested nowhere; and the secret-leak tests miss the three channels where the key actually lives (D1 rows, coordinator logs, tool-result envelopes). All fixes are prescribed and mechanical. **REVISE.**

## 2. What's Strong (earned)

- Every task T1–T18, T22–T31 has a genuine watch-it-fail with a concrete feature-missing failure mode; dependency order acyclic and truthful (execution).
- The commit sequence is rollback-safe: any single task reverts to a compiling green tree (execution).
- 40-file structure cleanly layered with no circular deps; per-request DI (`buildDefaultApiDeps`, `getProps` thunk, `this.env` in DOs) matches how OAuthProvider/McpAgent/Hono actually thread context — verified against current docs (architecture).
- `SwapMcpAgent.serve("/mcp")` with no `{binding}` is CONFIRMED correct for the OAuthProvider `apiHandlers` form (context7 + CF agent-api docs) — the `{binding}` shape belongs to the non-OAuth standalone style (architecture).
- Drift-floor branches are double-count-free and encode exactly the spec's semantics; routing-shape fail-closed, approval_required no-auto-send, never-retry-/swap, timeout-vs-revert lifecycle all correctly pinned (domain, scope).
- Non-goal audit clean: no multi-pair, UniswapX, SSE, or per-swap Permit2 smuggling; every file maps to a §5 component (scope).
- The decision-26 read-only-token coverage exercises the real production `requireScope` guards — only the minting is shortcut (scope) — though the minting mechanism itself is the Blocker below.

## 3. Blockers

1. **[security] T32 `mintTestToken` KV props-injection is unbuildable and backdoor-prone** (plan T31–T32). workers-oauth-provider end-to-end-encrypts grant props using the access token as key material; no documented seam exists to inject a forged props blob that the provider will decrypt for an independently minted bearer. Forcing a seam would create a real bypass of `completeAuthorization`. **Fix (prescribed):** drop the integration-level KV-injection helper entirely. Prove read-only rejection at the app-owned auth boundary in the workers pool: fake the already-injectable `deps.getProps` returning `{ scopes: ["swap:read"] }` and assert `requireScope(props,"swap:write")` rejects at (a) the real `registerExecuteSwap` registrar and (b) the real `POST /api/swap` route (via the T25 props-adapter seam). Remove `test/helpers/mintTestToken.ts` from T32 Files and tasks.json; rewrite T32's read-only assertion accordingly. Decision 26 (always grant both) is untouched — only the test mechanism changes.

## 4. Major Concerns (reconciled across lenses)

1. **[domain] Gas-headroom rail runs before its only data source.** T17 asserts rails needing `gasLimit × maxFeePerGas`, but `gasLimit` only exists on `SwapTx` returned by `buildSwap` — which spec §5.8/T17 sequence AFTER the rail. **Fix:** reorder `executeSwap` so the balance/gas-headroom rail runs after `buildSwap` (still before sign/submit; abort → `pending→failed`, no tx sent); amend T17 step list and spec §5.8 step numbering (mechanical correction, no semantic change).
2. **[domain] `ReceiptOutcome` is 3-way; non-timeout throws are unmodeled.** viem's `waitForTransactionReceipt` resolves with `status:"reverted"` and throws on timeout — but also throws on RPC errors/replacement. **Fix:** add an explicit default branch: any non-timeout throw → row stays `submitted` with txHash, result `timed_out` (reconcile path), never `failed`; add a T20 assertion for a non-timeout throw.
3. **[scope] G9's dual-surface AC is half-covered.** Mid-swap `submitted` visibility is asserted only via workers-pool `get_transaction`; the REST `GET /api/transactions/:id` integration half has no assertion. **Fix:** add a T32 integration assertion — fire `POST /api/swap` unawaited with the fake signer parked in waitForReceipt, then `GET /api/transactions/:id` over `exports.default.fetch()` asserting `status:"submitted"` before the swap response resolves.
4. **[security] MCP transport-guard + audience wiring untested.** `transportGuard` and `assertAudience` are unit-tested in isolation (T7) and asserted in prose at T31, but no test proves they're wired into the `/mcp` path/tool dispatch. **Fix:** T24 assertion that a tool call with `props.resource !== CANONICAL_MCP_URI` returns `forbidden`; T31/T32 integration assertions that `POST /mcp` with disallowed Origin or missing `MCP-Protocol-Version` is rejected before dispatch; make `assertAudience` a per-registrar wrapper alongside `requireScope`.
5. **[security] Secret-leak tests miss the channels the coordinator creates.** Serialization-only assertions don't cover D1 rows, coordinator `log()` on error branches, or tool-result envelopes. **Fix:** T18/T19 — after a forced signer throw carrying `getRpcUrl()`/key text, assert the D1 row and every captured `log()` call contain no secret values; T23/T32 — envelope from such an error carries no long-hex/secret-name values.
6. **[execution→minor after reconciliation, fix still applied] T1 serve-overload check has no fail-branch** — architecture's doc evidence confirms the no-`{binding}` form, downgrading the risk; still add the fail-branch ("if only a `{binding}` overload exists, pass `{ binding: "SwapMcpAgent" }` at T31 — do not block") and a pass/fail oracle. **[execution] T19/T32 inversion framing:** relabel as coverage-ratchet/regression-pin tasks explicitly exempt from watch-it-fail (plan-as-authorisation), not Iron-Law-compliant red.

## 5. Minor Issues & Nits (all folded into the fix pass)

- [security] CSRF token is replay protection, not session-binding — make T30 reject missing Origin AND Referer before CSRF/passphrase; note the Origin allowlist is the load-bearing cross-site control.
- [security] Use `crypto.subtle.timingSafeEqual` for the final 32-byte digest compare (T6) instead of a hand-rolled loop.
- [security] Pin `@modelcontextprotocol/sdk@^1.26` (cross-client leakage guard added in 1.26) in T1.
- [security+scope] Global rate-limit budget: add window-expiry recovery assertion (post-429, clock advance → operator can authenticate) at T28/T32; document global-lockout tradeoff in T33 ops how-to.
- [security] T30: assert the CSRF nonce is consumed on any POST outcome (success or mismatch); replay rejected.
- [scope] T31: broaden well-knowns assertion to every metadata document the provider serves (authorization-server + protected-resource).
- [domain] T13: pin `tokenIn`/`tokenOut` addresses in the `/quote` request-contract assertion; make the `/swap` fixture nested (`{ swap: {...} }`) and assert the unwrap; [T12] pin integer-bps conversion before the bigint multiply; optional decimals lock (1 ETH / 1 USDC base-unit strings).
- [architecture] T21/spec §5.8/T33: note the in-memory `#tail` mutex does not survive DO eviction — serialization is per-live-instance; cross-eviction safety rests on single-in-flight + D1 reconciliation. Don't overstate in docs.
- [architecture] T22: pin `server.registerTool(...)` (current SDK), not the older `server.tool(...)` overload.
- [execution] T18/T24/T28 + T33: single-`v1` migrations array is boot-safe locally only — real deploys need one tag per class addition; never `wrangler deploy` mid-build.
- [execution] T8: verify `readD1Migrations` export path against installed package exports before writing config; T2: annotate `SELECT 1` is deliberately schema-free; T20/T21 must run sequentially after T18 (shared files); global constraints: commit regenerated `worker-configuration.d.ts` with every cf-typegen task.
- [scope, nit] Optional integration assertion: `get_quote` output fed verbatim as `expectedAmountOut` is accepted.

## 6. Unstated Assumptions

- That an OAuthProvider test seam for props injection existed (it does not — Blocker 1).
- That `gasLimit` is available at rail-evaluation time (it is not — Major 1).

## 7. Missing Elements

Covered by Blockers/Majors above (G9 integration half, guard-wiring tests, leak-channel tests, non-timeout-throw branch).

## 8. Codebase & Convention Conflicts

None — pnpm/ESM/strict-TS/wrangler conventions and all current package APIs verified consistent (architecture lens, zero Majors).

## 9. Recommended Next Steps

1. Apply the prescribed fixes to plan.md + tasks.json (and the mechanical §5.8 step-order/eviction-note amendments to spec.md → v3.2).
2. Targeted re-verification of the Blocker + Majors (security/domain focused).
3. On clean re-verify: mark GO, lock plan, advance `.state` → `implement`.

## 10. Final Verdict

**REVISE** — one fixable security Blocker (unbuildable test seam) and six reconciled Majors, all with exact prescribed fixes; rework is hours of plan-editing, not redesign. Re-validate the fixed sections, then GO.
