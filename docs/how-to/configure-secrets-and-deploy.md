# Configure secrets and deploy

This guide takes a configured working tree to a running production deployment on
Cloudflare Workers. It covers the four secrets, the placeholder binding ids, the
Durable Object migration-tag rule, deployment, and the smoke check.

Follow the steps in order. The migration-tag rule and the global-rate-limit
tradeoff below are load-bearing — read them before your first deploy.

## 1. Set the four secrets

The server validates four secrets on every request and fails closed when any is
missing (`src/env.ts`, `wrangler.jsonc` `secrets.required`). Set each with
`wrangler secret put`, which prompts for the value and never writes it to the
repository:

```bash
wrangler secret put SWAP_PRIVATE_KEY
wrangler secret put AUTH_PASSPHRASE
wrangler secret put UNISWAP_API_KEY
wrangler secret put ETH_RPC_URL
```

- `SWAP_PRIVATE_KEY` — the private key of the single custodial swap wallet.
- `AUTH_PASSPHRASE` — the passphrase an operator types on the consent screen.
- `UNISWAP_API_KEY` — the Uniswap Trading API key.
- `ETH_RPC_URL` — the Ethereum mainnet RPC endpoint.

## 2. Replace the placeholder binding ids

`wrangler.jsonc` ships with placeholder ids for the KV namespace and the D1
database. Create the real resources and substitute their ids:

- `kv_namespaces[0].id` — currently `<placeholder-kv-id>`. This KV namespace
  backs OAuth token storage (`OAUTH_KV`).
- `d1_databases[0].database_id` — currently `<placeholder-d1-id>`. This D1
  database (`DB`) holds the `swaps` lifecycle table.

Create them with `wrangler kv namespace create` and `wrangler d1 create`, then
paste the returned ids over the placeholders.

The three Durable Object bindings — `SWAP_COORDINATOR`, `SwapMcpAgent`, and
`RATE_LIMITER` — need no id; Cloudflare provisions them from the class names on
deploy. Keep the `SwapMcpAgent` binding name equal to its class name:
`McpAgent.serve()` looks the object up by that name, so renaming it breaks `/mcp`
routing.

## 3. Apply the migration-tag rule before deploying

**One migration tag per Durable Object class.** During local build the three
SQLite-backed classes share a single `v1` tag in `wrangler.jsonc`
(`new_sqlite_classes: ["SwapCoordinator", "SwapMcpAgent", "RateLimiter"]`).
Growing one tag in place is boot-safe **locally only**. A real deploy must not
add classes to an already-applied tag; each class needs its own fresh tag:

- `v1` — `SwapCoordinator`
- `v2` — `SwapMcpAgent`
- `v3` — `RateLimiter`

Before your first `wrangler deploy`, split the single `v1` entry into three
ordered tag entries, one class per tag. **Never run `wrangler deploy`
mid-build** with classes stacked on one already-applied tag — Cloudflare rejects
adding `new_sqlite_classes` to a tag that has already run against the remote
namespace.

## 4. Deploy

```bash
pnpm deploy
```

This runs `wrangler deploy --minify`. Wrangler bundles `src/index.ts`, applies
any new migration tags, and publishes the Worker.

## 5. Run the smoke script

```bash
pnpm smoke
```

This runs [`scripts/smoke.ts`](../../scripts/smoke.ts) (wired as the `smoke`
script in `package.json`), which exercises the deployed surfaces end-to-end
against a **real** environment: it mints a token through the real OAuth consent
dance, then runs a tiny live ETH→USDC quote and swap and prints the persisted
row. It is **manual-only** — the automated test suite never runs it, and it hits
the real chain and the real Trading API, so it needs a deployed base URL and a
funded key.

Set these in your shell before running (the first two are always required):

```bash
export SWAP_MCP_BASE_URL=https://your-worker.workers.dev
export AUTH_PASSPHRASE=…   # the consent passphrase
```

The smoke client does not need `UNISWAP_API_KEY` — the deployed worker already
holds it server-side and makes the Trading API calls itself.

To also send the one-time USDC→Universal Router approval that the
[`USDC_TO_ETH` direction requires](one-time-usdc-approval.md), run
`pnpm smoke -- --approve` with `SWAP_PRIVATE_KEY` and `ETH_RPC_URL` also
exported. The script never sends an approval unprompted: `--approve` still asks
for an interactive `yes` before broadcasting. Without `--approve` it only
describes the approval it would send.

## Operational tradeoff: the global rate-limit lockout

The consent flow guards the passphrase compare with a fail-safe-closed rate
limiter (`src/ratelimit/RateLimiter.ts`). It enforces two failure budgets over a
fixed 10-minute tumbling window: **5 failures per IP** and **20 failures
globally across all IPs**.

The global budget is a shared ceiling. A burst of failed consent attempts — from
one misconfigured client or several operators at once — can exhaust the 20-
failure global budget and briefly **lock every operator out** of minting new
tokens, even operators typing the correct passphrase. This is a deliberate
fail-closed choice, not a bug. It self-recovers: the window tumbles lazily, so
once the current 10-minute window expires the global counter resets and consent
succeeds again. Existing tokens keep working throughout — only new token minting
is affected. If you expect concurrent operators, stagger token minting to stay
under the shared ceiling.
