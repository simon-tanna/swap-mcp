{
  "verdict": "needs-changes",
  "force_interview": false,
  "critical": [
    {
      "area": "§9 Q5 / SwapCoordinator quote-drift abort — product decision not authorised",
      "issue": "Q5 asks the reader to 'confirm' that the coordinator aborts with slippage_exceeded on re-quote drift rather than auto-executing within tolerance. This is presented as an open question with a stated default, but §8 and §5.8 (SwapCoordinator responsibility) already bake the re-quote-before-swap mechanic in as settled behavior, and the drift-handling policy is a genuine two-alternatives fork (abort-on-drift vs execute-if-within-tolerance) that changes what a caller can rely on for a money-moving operation. Neither source.md nor interview-log.md literally authorises 'abort on drift' as the chosen behavior — it is the drafter's default dressed as a question.",
      "fix": "Leave Q5 in §9 as a genuine Confirm question (it already is), but make sure §5.8/§8 do not assert the abort behavior as decided pending that confirmation — currently §5.8 states re-quoting as fact but is silent on the abort-vs-execute fork, so the two sections are consistent by omission. No spec text change strictly required, but flag Q5 as blocking for implementation start, not merely cosmetic."
    },
    {
      "area": "§9 Q6 — OAuth scope granularity is an access-control decision, not a numeric default",
      "issue": "Two-scope model (`swap:read`/`swap:write`) vs single `swap` scope is an access-control-model decision (category: access-control), not a numeric/process detail. §9's framing ('numeric/process details not fixed by the fifteen answers') undersells this — it materially changes the authorization model implemented throughout §5.5, §5.7, §5.12, and G2/G4 acceptance criteria, none of which hedge on the outcome. Neither source.md nor interview-log.md authorises two scopes; it is the drafter's inference from 'a future read-only token' convenience.",
      "fix": "Keep as an open question (already is) but explicitly recategorize it in §9 as an access-control decision requiring human confirmation before §5.5/§5.7/§5.12 are implemented against it, since those sections currently assume the two-scope model as settled fact rather than provisional."
    },
    {
      "area": "§9 Q4 — passphrase rate-limiting is a security-posture decision baked into §5.6 without authorisation",
      "issue": "§5.6 states 'On mismatch → re-render with error (rate-limited, see §9)' — treating rate limiting as decided (just deferring the numeric knob), while §9 Q4 frames the entire existence of throttling as an open confirm. This is an access-control / attack-surface decision (brute-force defense on the sole auth gate for a custodial hot wallet) not authorised by source.md or any interview answer — interview-log.md round 3 item 10 only says 'passphrase checked against a Worker secret,' nothing about rate limiting.",
      "fix": "Either (a) get explicit human authorisation for 'yes, add rate limiting' as a threshold decision before locking, or (b) soften §5.6's language so it doesn't assert rate-limiting as already-decided ('policy TBD, see Q4') pending the Q4 answer landing before implementation of the auth layer begins."
    }
  ],
  "important": [
    {
      "area": "§9 Q1/Q2/Q3 — 'Confirm' questions with only one alternative offered, not genuine forks",
      "issue": "Q1 (timeout), Q2 (retry policy), Q3 (pagination) are lower-stakes engineering defaults correctly scoped as non-blocking, but they are phrased as 'Confirm: X? (alternative: Y)' without any record of the human actually being asked and answering — interview-log.md's four rounds do not cover these. They are process/threshold-category and reasonably left as drafter defaults per standard practice, but the spec should be explicit that implementation may proceed with the stated default absent objection, rather than implying these are still pending a synchronous confirm gate that blocks Phase 1.",
      "fix": "Add one sentence to §9 preamble clarifying that Q1–Q4, Q6 are non-blocking defaults that implementation proceeds with unless the human overrides during Stage review, distinguishing them from Q5 (which affects on-chain money-moving behavior and should block SwapCoordinator implementation until resolved)."
    },
    {
      "area": "§10 Risk item — unbounded receipt wait ties bound to deadlineSeconds without authorisation, contradicts 'not yet confirmed' framing",
      "issue": "§10 states 'bound the wait (tie to the swap deadlineSeconds...)' as the mitigation, then in the same bullet says '(Confirm the wait bound alongside Q1 if the 1200s tie is not desired.)' — this decision (how long to hold a Worker request open waiting on a receipt, with a fallback to swap_failed) affects billing/compute cost and user-facing behavior on an irreversible on-chain operation, and is asserted as the mitigation in §10 while simultaneously flagged as unconfirmed. That is an internal consistency issue: §10 treats it as decided, §9 does not carry a corresponding numbered question for it.",
      "fix": "Add an explicit Q7 to §9 ('receipt-wait bound tied to deadlineSeconds, default 1200s — confirm?') so the decision has one canonical location instead of being simultaneously asserted in §10 and hedged parenthetically."
    },
    {
      "area": "Mainnet contract addresses embedded in §5.9 — no source for correctness beyond drafter research",
      "issue": "USDC, WETH9, Universal Router, and Permit2 addresses are hardcoded in prose. These are attributed to 'Research B' in §8, which is reasonable for factual/process addresses (not a product fork), but the spec provides no verification mechanism (e.g., a test asserting the constant matches a known checksum, or a comment citing the Uniswap docs page) — an error here is a fund-loss risk (custodial wallet sending to a wrong contract) and warrants a stronger acceptance-criteria checkpoint than 'engine issues quotes' in G5.",
      "fix": "Add an explicit acceptance-criteria line under G5 or G8 requiring a unit test that asserts each hardcoded mainnet address against a known-good checksummed constant/reference, and note in §10 as a risk with mitigation beyond current framing."
    }
  ],
  "minor": [
    {
      "area": "§5.7 get_transaction justification duplicated in §8",
      "issue": "The justification for including get_transaction (decision 4) is written out fully in §5.7 and then referenced again in §8's rationale column with a shortened paraphrase — minor duplication, not contradictory, just slightly redundant.",
      "fix": "Optional: §8 rationale column could just say 'see §5.7' instead of restating."
    },
    {
      "area": "§4/§5.1 DO naming consistency",
      "issue": "§4 and §5.1 both reference `SwapMcpAgent` and `SwapCoordinator` as DO bindings consistently — no drift found, noted as a positive, not a defect.",
      "fix": "None needed."
    },
    {
      "area": "G12 placeholder list vs §5.1 binding list",
      "issue": "G12 lists placeholders as `OAUTH_KV, D1 id, DO bindings, SWAP_PRIVATE_KEY, AUTH_PASSPHRASE, UNISWAP_API_KEY, ETH_RPC_URL` — matches §5.1 exactly. No drift.",
      "fix": "None needed."
    }
  ],
  "open_questions": [
    "Should the receipt-wait bound (tied to deadlineSeconds) be a formally numbered §9 question (proposed Q7) rather than only appearing inside the §10 risk mitigation?",
    "Is passphrase rate-limiting (Q4) actually authorised as 'yes, implement some throttle' by the human, or only the numeric parameters — i.e., was the existence of throttling itself confirmed, or only inferred by the drafter from general security best practice?",
    "For Q5 (quote-drift abort behavior), was this specific fork (abort vs execute-within-tolerance) ever put to the human, or is it purely the drafter's engineering judgment presented retroactively as a confirm-style question?",
    "Should the two-scope OAuth model (Q6) be resolved before Phase 1 auth-layer TDD begins, given §5.5/§5.7/§5.12 already implement against it as settled?",
    "What is the reconciliation process (beyond 'documented note') for a swap DO-crash-stranded in `submitted` status — §10 acknowledges the risk but the mitigation is manual/undefined; should this be a smoke-script or ops runbook deliverable under G13 docs?"
  ],
  "product_decisions_flagged": [
    {
      "decision": "Two-scope OAuth model (swap:read / swap:write) granted together at consent",
      "category": "access-control",
      "authorised_by_source": false,
      "alternative": "Single unified 'swap' scope",
      "reason": "Neither source.md nor interview-log.md records the human choosing scope granularity; interview round 3 item 10 only covers passphrase-vs-secret consent, not scope design. This changes the authorization model exposed to future clients and is currently implemented as settled fact in §5.5/§5.7/§5.12 while still labeled 'open' in §9."
    },
    {
      "decision": "Passphrase rate-limiting (5 attempts/IP/10min via OAUTH_KV, then 429) on the sole auth gate",
      "category": "access-control",
      "authorised_by_source": false,
      "alternative": "No throttle (acceptable per spec's own alternative framing for a single-operator POC)",
      "reason": "§5.6 asserts rate-limiting as decided ('re-render with error, rate-limited, see §9') while §9 frames the entire existence of throttling as open. No interview record authorises adding this control; it is a drafter-inferred security default for the credential gate protecting a custodial hot wallet."
    },
    {
      "decision": "Quote-drift handling: abort with slippage_exceeded on re-quote drift vs execute within self-tolerance",
      "category": "irreversible-op",
      "authorised_by_source": false,
      "alternative": "Execute on the fresh quote as long as it's within the fresh quote's own tolerance, regardless of drift from the original preview",
      "reason": "This governs behavior of an irreversible on-chain money-moving call (execute_swap) under price movement. No interview round records the human choosing between these two alternatives; it is presented as a drafter default in Q5, but §5.8's coordinator responsibility description already establishes re-quoting as mandatory without hedging on the abort policy."
    },
    {
      "decision": "Receipt-wait timeout bound tied to deadlineSeconds (default 1200s) before mapping to swap_failed",
      "category": "irreversible-op",
      "authorised_by_source": false,
      "alternative": "A separate, shorter hard timeout independent of deadlineSeconds, or no bound (let Worker request-duration limits be the natural cutoff)",
      "reason": "Affects Worker compute cost/billing exposure and the caller-facing failure semantics for a submitted-but-unconfirmed on-chain transaction. Presented as settled mitigation text in §10 but simultaneously hedged as unconfirmed in the same sentence; no §9 question number tracks it, and no interview record authorises the specific tie-to-deadlineSeconds mechanism."
    }
  ]
}