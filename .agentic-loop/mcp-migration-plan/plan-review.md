# plan-review.md — aggregated review verdict on plan.md (iteration 1)

Three parallel passes: structured plan-reviewer (code-reviewer, 11 checks) → approved with 2 minors; domain-specialist sanity check on synthesis → faithful (zero drops/alterations/contradictions/order problems); adversarial attack-surface audit vs source.md/interview-log.md → needs-changes (1 important). Aggregate = most severe wins.

```json
{
  "verdict": "needs-changes",
  "critical": [],
  "important": [
    {
      "task_id": "T30 / Resolved planning choice 1",
      "source": "adversarial",
      "issue": "Plan introduces scope-intersection logic (requested ∩ [\"swap:read\",\"swap:write\"], defaulting to both) at the consent POST. Spec §5.6 literally hardcodes completeAuthorization with scopes: [\"swap:read\",\"swap:write\"] — an unconditional two-scope grant — and interview decision 17 authorised 'both scopes granted together at consent'. Scope-granting is the core access-control trust boundary; the intersection mechanism is a new authorization-narrowing code path observable by any DCR-registered client, not literally authorised by source.md/interview-log.md/spec §8. Not implementer latitude.",
      "fix": "Interview: (a) confirm spec-literal always-grant-both and drop intersection (T30 hardcodes both scopes; T32 gains a test-only read-only-token minting path to preserve its negative-path coverage), or (b) explicitly re-author decision 17 to authorise per-request scope negotiation."
    }
  ],
  "minor": [
    {
      "task_id": "T24",
      "source": "plan-reviewer",
      "issue": "SwapMcpAgent DO binding name mirrors its class name (agents SDK .serve() convention) while the other two DOs use SCREAMING_SNAKE — deliberate but asymmetric; an implementer might 'fix' it.",
      "fix": "Add one explicit note in T24 (and/or T2) that the mirror-naming is intentional per the agents SDK convention."
    },
    {
      "task_id": "T19,T32",
      "source": "plan-reviewer",
      "issue": "Deliberate-inversion red checks (sanctioned exception for breadth-only integration tasks) deviate from strict red-first TDD; risk is the inversion step being skipped as a formality.",
      "fix": "None in plan (already documented); per-task review in Stage 3 must confirm the inversion was actually executed."
    },
    {
      "task_id": "T32",
      "source": "adversarial",
      "issue": "T32's read-only-token negative test currently relies on production scope-intersection to mint a swap:read-only token; if choice (a) is selected in the interview, that mechanism disappears.",
      "fix": "On choice (a): add a test-only token-minting path (direct props injection) so 'swap:read-only token rejected by every write path' coverage survives."
    }
  ],
  "sanity_check": { "verdict": "faithful", "drops": [], "alterations": [], "contradictions": [], "order_problems": [] },
  "force_interview": true,
  "product_decisions_flagged": [
    {
      "category": "access-control trust boundary (OAuth scope grant)",
      "decision": "scope-intersection vs unconditional both-scopes grant at consent",
      "authorised_by_source": false
    }
  ]
}
```
