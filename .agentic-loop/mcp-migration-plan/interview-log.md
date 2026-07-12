# Interview Log — mcp-migration-plan

All rounds run interactively via AskUserQuestion. Answers are literal authorisation for spec §8.

## Round 1
1. **Custody**: Server hot wallet (custodial). No co-signer. Server wallet associated with exactly one database user. This is a POC.
2. **OAuth/IdP**: Self-contained consent screen (no third-party IdP).
3. **Git remote**: User will add remote themselves; commits stay local until then; PR at Stage 4 once remote exists.
4. **MCP tool surface**: quote + swap + history (get_quote, execute_swap with ~0.5% default slippage, list_transactions).

## Round 2
5. **HTTP surface**: Full REST mirror (/api/quote, /api/swap, /api/transactions, same OAuth bearer auth) alongside MCP.
6. **DB tracking**: Full lifecycle — direction, in/out amounts, quoted vs actual output, slippage, tx hash, status pending→submitted→confirmed/failed, gas used, timestamps, user id; failed attempts recorded.
7. **Safety rails**: Sensible defaults — slippage 0.5% default / 5% hard cap, ~20 min deadline, amount > 0 and ≤ balance; no per-swap USD cap.
8. **Test network policy**: Fully mocked chain/API in all tests; manual smoke script for real-chain verification run by the user.

## Round 3
9. **Swap engine**: Uniswap Trading API + viem (over direct SDK encoding).
10. **Consent login**: Single operator passphrase checked against a Worker secret (placeholder).
11. **Confirmation**: Wait for receipt — execute_swap returns final confirmed/failed with actual amounts.
12. **DB layer**: Drizzle ORM (matches reference app; drizzle-kit migrations).

## Round 4 (follow-up requirement: full tx-state visibility)
13. **State + DO**: SwapCoordinator Durable Object serializes swap execution (nonce safety) + writes every lifecycle transition to D1 eagerly; D1 is the source of truth; visibility by reading D1 (MCP tools + GET /api/transactions). No SSE push.

## Standing process constraints (from user, same session)
- OAuth is mandatory for MCP authentication.
- No AI-attribution / Co-Authored-By: Claude trailers on any commit.
- Every build phase TDD.
- Documentation via writing-documentation (Diátaxis) skill.
- Cloudflare bindings/tokens: placeholders; user supplies real values.

## Round 5 (post spec-review v1)
14. **Quote drift**: Abort on drift — if fresh quote output < preview output × (1 − tolerance), abort with slippage_exceeded, failed row, no tx sent.
15. **Scopes**: swap:read + swap:write, both granted at consent.
16. **Rate limit**: Throttle /authorize — 5 failed attempts per IP per 10 min via OAUTH_KV counter, then 429.
17. **Receipt wait**: Bound tied to deadlineSeconds (default 1200s); on timeout status stays 'submitted' with txHash recorded, result reports timed_out for reconciliation.
18. **API resilience**: 8s per-call timeout → upstream_unavailable; ≤2 jittered exp-backoff retries (250ms→500ms) for /quote and /check_approval only; never retry /swap or submitted txs.
19. **Pagination**: Opaque cursor over createdAt+id; default limit 20, max 100.
20. **Runbook**: Yes — docs how-to for reconciling swaps stranded in 'submitted'.

## Round 6 (post validating-specs REVISE on spec v2)
21. **Drift design**: Caller-supplied floor — execute_swap gains optional expectedAmountOut; if supplied, abort with slippage_exceeded when fresh quote output < expectedAmountOut × (1 − tolerance); if omitted, fresh quote is the baseline and the on-chain amountOutMinimum is the only rail.
22. **DCR posture**: Open DCR + hardened consent — /register stays open (Claude connector needs it); consent page gets CSRF token bound to the auth request, prominent display of client name + exact redirect URI, strict redirect_uri validation.
23. **Rate limiter (amends #16)**: RateLimiter Durable Object (strongly consistent) enforcing 5 failed/IP/10min AND a global 20 failed/10min budget across all IPs; IP from trusted CF-Connecting-IP only.

## Round 7 (post plan-review iteration 1)
26. **Consent scope grant (amends nothing — confirms #15/#17 literally)**: Always grant both scopes `["swap:read","swap:write"]` unconditionally at consent, exactly as spec §5.6 states — never derived from client-requested scopes. The plan's scope-intersection draft is rejected. T32's read-only-token negative tests use a test-only props-injection helper (`mintTestToken`), never a production path.
