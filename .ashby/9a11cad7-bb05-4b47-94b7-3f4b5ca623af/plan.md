# Implementation Plan — PROTOTYPE PROBE #28 child card

## Summary

This card is a **child card** of parent Case `a0e44357-a101-46b0-be41-9f202957d39a` on `simon-tanna/ashby-scratchpad`.
It exists to prove that a child card bound to a second Target Repository (`simon-tanna/swap-mcp`)
can be built and submitted. There is **no Intake Issue** on this repository, so there is no
`gh issue view` to run: this plan is the Requirement. There is no `spec.md` and no `research.md`
for this child; do not look for them.

## Approach

One Task. Add a marker file that records the parent and child card ids. No code changes.

## Tasks

### T1: Record the child-card probe marker

- File targets: `abis/.ashby-probe-28.md`
- Test targets: not applicable (documentation-only file)
- Assertions:
  - `abis/.ashby-probe-28.md` exists on the Work-Item Branch.
  - It contains the line `parent: a0e44357-a101-46b0-be41-9f202957d39a`.
  - It contains the line `child: 9a11cad7-bb05-4b47-94b7-3f4b5ca623af`.
  - It contains one line `built-at: <ISO-8601 UTC timestamp of the commit>`.
- Commit message: `T1: record the child-card probe marker`

## Sequencing

T1 only.

## Risks

None. The file is inert.

## Resolved Decisions

- Verification Commands: neither `make evm-test` nor `make solana-test` exists in this
  repository (there is no Makefile). Record **both** as `skipped` with the note
  "swap-mcp has no Makefile; probe #28 marker file only". Run no other test suite.
- Delivery PR: a **draft** PR on `simon-tanna/swap-mcp` from branch `factory/item-9a11cad7-bb05-4b47-94b7-3f4b5ca623af`
  titled "PROTOTYPE PROBE #28: child-card marker". The body's `Refs` line is
  `Refs parent Case a0e44357-a101-46b0-be41-9f202957d39a` (no issue number exists).

## Open Questions

None.
