# swap-mcp

OAuth-protected Uniswap swap service on Cloudflare Workers, exposing an MCP
server and a mirrored REST API.

> **Status:** Code-complete and fully tested (203 tests), not yet deployed.
>
> **Trust model:** Single-operator **custodial**. The Worker holds one funded
> private key and signs swaps on your behalf. Anyone who mints a token can spend
> from that key, bounded only by the swap safety rails. Run it for yourself, not
> as a shared service.
>
> **Before you deploy:** split the Durable Object migration tags into `v1`/`v2`/`v3`
> and set `CANONICAL_MCP_URI` to your real Worker origin. Both steps are covered in
> [the deploy how-to](docs/how-to/configure-secrets-and-deploy.md).

## What it is

An AI agent (over the Model Context Protocol) or any HTTP client (over REST)
requests price quotes and executes ETH↔USDC swaps through the Uniswap Trading
API. A single OAuth 2.1 access token authorizes both surfaces; the `/mcp` and
`/api` handlers are mirrors of the same four operations.

Every swap is persisted in D1 and serialized through a Durable Object
coordinator that enforces one in-flight swap at a time and applies drift,
slippage, and balance safety rails before signing. Failed or interrupted swaps
leave a durable row you can reconcile against the chain.

## Architecture at a glance

| Surface             | Path                                | Auth                                            |
| ------------------- | ----------------------------------- | ----------------------------------------------- |
| MCP server          | `/mcp`                              | Bearer token, `swap:read` / `swap:write` scopes |
| REST mirror         | `/api`                              | Same token, same scopes                         |
| OAuth 2.1 + consent | `/authorize`, `/token`, `/register` | Passphrase-gated consent                        |

The entry point (`src/index.ts`) is a `@cloudflare/workers-oauth-provider`
instance wrapping the MCP and REST handlers. It binds:

| Binding           | Type           | Purpose                     |
| ----------------- | -------------- | --------------------------- |
| `OAUTH_KV`        | KV             | OAuth grant + consent state |
| `DB`              | D1             | The `swaps` table (drizzle) |
| `SwapCoordinator` | Durable Object | Serializes swap execution   |
| `SwapMcpAgent`    | Durable Object | Per-session MCP agent       |
| `RateLimiter`     | Durable Object | Passphrase-attempt budgets  |

## Surfaces

Each MCP tool has a REST mirror and a required scope:

| MCP tool            | REST mirror                 | Scope        |
| ------------------- | --------------------------- | ------------ |
| `get_quote`         | `POST /api/quote`           | `swap:read`  |
| `execute_swap`      | `POST /api/swap`            | `swap:write` |
| `list_transactions` | `GET /api/transactions`     | `swap:read`  |
| `get_transaction`   | `GET /api/transactions/:id` | `swap:read`  |

For request/response schemas, the `swaps` data model, and the 11-code error
allowlist, see [the API and data-model reference](docs/reference/api-and-data-model.md).

## Quick start

```bash
pnpm install   # install dependencies
pnpm dev       # run the Worker locally with hot reload
pnpm test      # run the full suite (203 tests, zero network)
```

The suite mocks all chain and Trading API I/O, so it needs no secrets. For the
full local walkthrough (mint an operator token through the OAuth dance and run
a mocked quote), follow [the getting-started tutorial](docs/tutorials/getting-started.md).

## Documentation

The `docs/` tree follows the [Diátaxis](https://diataxis.fr/) framework:

**Tutorial**

- [Getting started](docs/tutorials/getting-started.md): stand up locally, mint a token, run a mocked quote.

**How-to guides**

- [Configure secrets and deploy](docs/how-to/configure-secrets-and-deploy.md): set the four secrets, replace binding ids, apply migration tags, deploy.
- [Run the one-time USDC approval](docs/how-to/one-time-usdc-approval.md): clear an `approval_required` failure on USDC→ETH swaps.
- [Reconcile a stranded submitted swap](docs/how-to/reconcile-stranded-submitted.md): resolve a swap stuck in `submitted`.

**Reference**

- [API and data model](docs/reference/api-and-data-model.md): MCP tools, REST endpoints, `swaps` schema, error allowlist.

**Explanation**

- [Architecture decisions](docs/explanation/architecture-decisions.md): why OAuthProvider + McpAgent, the coordinator, the safety rails, and the custodial trade-offs.

## Commands

| Command            | What it does                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| `pnpm dev`         | Local dev server (`wrangler dev`)                                           |
| `pnpm deploy`      | Deploy to Cloudflare (`wrangler deploy --minify`)                           |
| `pnpm test`        | Run the vitest suite                                                        |
| `pnpm typecheck`   | Type-check with `tsc --noEmit`                                              |
| `pnpm lint`        | Check formatting (`prettier --check`)                                       |
| `pnpm format`      | Apply formatting (`prettier --write`)                                       |
| `pnpm cf-typegen`  | Regenerate the `CloudflareBindings` type                                    |
| `pnpm db:generate` | Generate a drizzle migration from the schema                                |
| `pnpm smoke`       | Manual real-chain smoke script: hits a deployed env; never run by the suite |

## Tech stack

Cloudflare Workers (Hono, Durable Objects, D1, KV), `@cloudflare/workers-oauth-provider`,
`@modelcontextprotocol/sdk`, the `agents` SDK, drizzle-orm, viem, and zod. Tested
with vitest and `@cloudflare/vitest-pool-workers`.

## License

No license file yet.
