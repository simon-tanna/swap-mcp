# Source Task Card — swap-mcp

Delivered interactively via `/spec-to-pr:agentic-loop` on 2026-07-12 by simon.tanna@proton.me.

## Raw request

> /Users/simontanna/Repos/github/labrys/rocksolid-strata-os/apps/agent-api
> See the agent api in the listed directory. We need to implement a similar
> mcp/http app here. The big difference is that it is going to be a simple swap
> app that swaps ethereum to usdc or usdc to ethereum on mainnet. As a base we
> want to use the uniswap sdk for this. We also need to track transactions in a
> database. i'd like to use cloudflare d1. for bindings and tokens for
> cloudflare just use placeholders. I will provide. Each build phase must be
> tdd. Use context7, /cloudflare:cloudflare and the cloudflare mcp and any of
> the uniswap skills to verify how this can work. Interview me in depth on
> design decisions. Everything must be documented using /writing-documentation.
> Force the use of the agentic loop flow.

## Follow-up addenda (same session)

> Oh and we must use oauth for mcp authentication

> None of the commits should have authored by claude

(Process constraint: no `Co-Authored-By: Claude` / AI-attribution trailers on any
commit made during this run — applies to controller state commits and all
implementer subagent commits.)

## Extracted requirements

- Model the app on `rocksolid-strata-os/apps/agent-api` (MCP + HTTP app on Cloudflare Workers / Hono).
- Scope: a simple swap app — ETH → USDC and USDC → ETH on Ethereum mainnet only.
- Swap engine: Uniswap SDK as the base.
- Persistence: track transactions in Cloudflare D1.
- Cloudflare bindings/tokens: placeholders only; user will supply real values.
- MCP authentication MUST use OAuth.
- Every build phase must be TDD.
- Research/verification via context7, the cloudflare skill + Cloudflare MCP/docs tools, and the Uniswap skills.
- All documentation via the writing-documentation (Diátaxis) skill.
- User explicitly requests an in-depth design interview.
