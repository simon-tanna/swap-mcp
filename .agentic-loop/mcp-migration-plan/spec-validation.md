# spec-validation.md — validating-specs merged report (spec v3 → v3.1)

Run: re-validation after the v2 REVISE. 2 parallel spec-design-validator instances (domain+scope, architecture+security) doing fix-verification + fresh-eyes sweep, alongside the structured code-reviewer pass (approved). Controller synthesis below.

## 1. Executive Summary

All 30 v2 findings (7 Blockers, 13 Majors, minor batch) are verified genuinely fixed — 18/18 in domain+scope, 12/12 in architecture+security. The sweep found one new Major introduced by the v3 drift-floor rewrite: the spec described a "router-enforced `amountOutMinimum` carried in `/swap`" mechanism that does not exist on the Trading API path (the API embeds the slippage-derived floor in opaque calldata; the service never computes that field). The finding came with an exact prescribed rewrite, which the controller applied verbatim across all 12 affected sites (spec v3.1), together with the sweep's minor/nit polish (fail-safe-closed rate-limiter reservations, success resets per-IP window, fixed-tumbling windows with lazy expiry, single ALLOWED_ORIGINS source, indicative version pin, service-computed quote freshness hint, revert-retains-txHash clarification). **GO.**

## 2. What's Strong (earned)

- Every one of the 25 decisions traces to a literal interview authorisation (rounds 1–6) — confirmed independently by the structured reviewer and both validator instances.
- The dual-branch drift-floor semantics (caller-supplied `expectedAmountOut` vs API-embedded slippage floor) is coherent, consistently encoded across §5.7/§5.8/§5.11/§5.12/§6/§7, and eliminates the v2 double-count.
- The security posture is now defensible end-to-end: CSRF-before-passphrase, hardened open-DCR consent, strongly-consistent RateLimiter DO (per-IP + global budgets), digest-based constant-time compare, enforced redaction, secret accessors, resource-param validation.
- Test matrix carries dedicated rows for the highest-risk behaviors: G7 DO concurrency (in-DO promise-chain mutex), G9 mid-swap interleaving, timeout-vs-revert disambiguation, approval_required gating, tampered-cursor rejection, redaction leak test.

## 3. Blockers

None.

## 4. Major Concerns

- ~~Trading-API `amountOutMinimum` mischaracterization (domain)~~ — **fixed in v3.1** by the controller applying the validator's prescribed rewrite at all sites (§0 map, §5.7, §5.8 step 3/6, §5.9, §5.14, §6 matrix, §7 G3/G5, §8, §10). The sole remaining `amountOutMinimum` mention is the explanatory negation in §5.8.

## 5. Minor Issues & Nits

All folded into v3.1: RateLimiter reservation fail-safe-closed + per-IP reset on success + fixed-tumbling lazy-expiry windows (§5.6a/§5.17); single `ALLOWED_ORIGINS` config for both Origin allowlists (§5.6); `@cloudflare/vitest-pool-workers` 0.18.4 marked indicative (pin whatever exports `cloudflareTest()` at install); `get_quote` freshness hint is service-computed (API returns no expiry field) (§5.7); reverted-swap `failed` rows retain `txHash` (§5.8 step 8).

## 6. Unstated Assumptions

None remaining that gate implementation.

## 7. Missing Elements

None remaining that gate implementation.

## 8. Codebase & Convention Conflicts

None — wrangler/cf-typegen/pnpm/ESM/strict-TS conventions all verified compatible with the scaffold.

## 9. Recommended Next Steps

1. Lock spec v3.1; advance `.state` → `plan`.
2. Stage 2 plan loop: dispatch plan → domain TDD plans → synthesized `plan.md` + `tasks.json` → plan review + plan validation.
3. At implementation time: verify the installed `agents` package's `.serve` overload and the actual `@cloudflare/vitest-pool-workers` version exporting `cloudflareTest()` (both flagged as install-time checks in the spec).

## 10. Final Verdict

**GO** — all v2 findings verified fixed; the single new Major was fixed in place (v3.1) per the validator's prescribed text; remaining items are install-time verifications already encoded in the spec. Implementation can safely start.
