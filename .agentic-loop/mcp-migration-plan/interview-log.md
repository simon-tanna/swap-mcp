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
