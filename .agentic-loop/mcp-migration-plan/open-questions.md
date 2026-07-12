# Open Questions — spec iteration 1

From spec §9 + spec-review product_decisions_flagged (all unauthorised until answered).

1. (Q5, blocking — irreversible-op) Quote-drift policy in execute_swap: coordinator always re-quotes before /swap; if the fresh quote drifts beyond the caller's slippage tolerance vs the preview, abort with slippage_exceeded — or execute on the fresh quote as long as it is internally within tolerance?
2. (Q6 — access-control) OAuth scopes: two scopes swap:read / swap:write, or a single swap scope?
3. (Q4 — access-control) Passphrase rate limiting on /authorize: throttle (5 attempts/IP/10 min via OAUTH_KV → 429), or no throttle for the POC?
4. (Q7 — irreversible-op, promoted from §10) Receipt-wait bound: tie to deadlineSeconds (default 1200s) then map to swap_failed with txHash persisted — or a separate shorter hard timeout?
5. (Q1 — threshold) Trading API per-call timeout: 8s (suggested) vs 15s.
6. (Q2 — threshold) Retry policy: 2 retries w/ jittered backoff for idempotent /quote & /check_approval only, never /swap — vs no retries.
7. (Q3 — threshold) list_transactions pagination: default limit 20 / max 100 / cursor — vs offset pagination.
8. (reviewer) Stranded-'submitted' reconciliation: add an ops runbook/how-to section (docs deliverable) for DO-crash recovery — yes/no?
