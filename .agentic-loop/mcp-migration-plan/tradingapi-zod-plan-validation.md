# Validation Report — Trading API Zod Boundary-Validation Plan

**Artifact:** `~/.claude/plans/glowing-questing-lagoon.md` (refinement plan for `src/engine/tradingApiClient.ts`)
**Run:** validating-specs, 1 all-lenses `spec-design-validator` instance; required tooling `swap-integration` skill + `context7` MCP.
**Verdict as reviewed:** REVISE (2 Blocker · 1 Major · 4 Minor · 2 Nit) → **all findings folded into the finalized plan; now GO.**

## 1. Executive Summary

The plan's core thesis — replace unchecked `as` casts over the untrusted Uniswap Trading API
with Zod runtime validation at the boundary, mirroring `cursor.ts` — is correct and
well-grounded. The pivotal technical claim (default `z.object()` strips unknown keys;
`buildSwap` re-forwards the whole quote to `/swap` so `/quote` must preserve extras) was
**CONFIRMED** via context7 (`/colinhacks/zod`) and the `swap-integration` skill. The
validator found one real defect in the plan's own schema (loose is per-level, not recursive;
the plan left `output` in strip mode) plus a self-contradiction in the `checkApproval` schema.
Both are fixed in the finalized plan.

## 2. What's Strong

- Correct root-cause framing: the `as` casts are the same defect class fixed in T13/T14 review, and the latent `readQuotedOutput` TypeError gap is real (`tradingApiClient.ts:86-89`).
- `upstream_unavailable` is the right fail-closed code (502 semantics), consistent with T13/T14 and `errors.ts`; the plan correctly rejects `invalid_input` (400).
- `safeParse` outside `requestWithPolicy` is sound — transport `AppError`s propagate and are never swallowed/double-wrapped.
- DRY `CLASSIC_ROUTINGS` tuple feeding `z.enum` + Set + type is valid zod v4; grep confirms no third literal copy.

## 3. Blockers (resolved in finalized plan)

- **B1 — loose is per-level, not recursive.** Plan left `output: z.object({ amount })` in strip mode, dropping `quote.output.token` from the re-forwarded `/swap` body; existing test `trading-api-shapes.test.ts:210` (`toEqual(quoteClassic.quote)`) would go red. **Fix applied:** `output: z.looseObject({ amount: z.string() })`; rule added that every re-forwarded nested object must be loose.
- **B2 — loose-preservation test too shallow.** Guard asserted only top-level extras; would pass while `output.token` was stripped. **Fix applied:** test now asserts a deeply-nested `quote.output`-level extra survives into the `/swap` body, and re-runs the `:195/:210` deep-equal test as a named regression gate.

## 4. Major Concerns (resolved)

- **`z.infer` narrows required fields.** Replacing the hand-written type drops the compile-time guarantee on `gasFee`/`slippage`/`route`/`output.token`/etc. No current consumer reads them as required (grep-confirmed: `readQuotedOutput` reads only `output.amount`; T16 → `quotedAmountOut`; T17 → `SwapTx.gasLimit` from `/swap`; `rails.ts` → own inputs). **Fix applied:** plan now documents the intentional narrowing + a re-grep at implementation time.

## 5. Minor Issues & Nits (addressed)

- **checkApproval contradiction (Minor).** `z.object({ approval: z.unknown() })` makes the key optional, so a malformed `{}` body would pass as "approved" — contradicting test 4. **Fix applied:** `approval: z.union([z.looseObject({}), z.null()])` (key required, object-or-null), and test 4 reworded (missing key / non-object → reject).
- **Error code (Minor).** Confirmed correct — no change.
- **DRY enum (Minor).** Confirmed sound — no change.
- **safeParse non-swallow (Minor).** Confirmed sound; added a transport-error-still-throws guard test (`trading-api-retry.test.ts:108` stays green).
- **`permitData` declaration (Nit).** Cosmetic/redundant but harmless; kept for documentation.
- **`quote`-absent test (Nit).** **Fix applied:** added a `quoteClassicNoQuote` fixture + test.

## 6. Unstated Assumptions

- The real `/swap` endpoint rejects a trimmed quote — confirmed via `swap-integration` skill, not assumed.
- Zod v4 `looseObject` semantics — confirmed via context7, not assumed.

## 7. Missing Elements (added to plan)

- Deeply-nested loose-preservation assertion; `quote`-absent case; malformed-approval semantics; transport-error non-swallow guard. All now in the TDD section.

## 8. Codebase & Convention Conflicts

- None. The plan follows the `cursor.ts` boundary-validation precedent, the `errors.ts` allowlist, and the repo's `rejects.toThrow(new AppError(...))` test style.

## 9. Recommended Next Steps

1. Implement test-first per the finalized plan (fixtures → red tests → schemas + method bodies → green).
2. Two-stage review (spec-compliance + code-quality) + fix-verification if flagged.
3. Land as a single `refactor(engine): …` commit before T15; resume the loop.

## 10. Final Verdict

**GO** (as finalized). Reviewed at REVISE; every Blocker/Major/contradiction is now resolved in the plan. Estimated effort: ~1 focused implementation pass + review. Core loose/passthrough thesis CONFIRMED (context7 `/colinhacks/zod`); the only correction — loose is per-level — is incorporated.
