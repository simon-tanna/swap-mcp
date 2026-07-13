# Getting started

This tutorial stands the swap-mcp server up on your own machine, mints an
operator token through the real OAuth consent flow, and runs a quote against a
mocked Trading API. You finish with a running server, a working token, and a
quote in hand.

You need Node 20+, [pnpm](https://pnpm.io) (pinned in `package.json`), and a
terminal. You do not need a funded wallet or a real Uniswap key: this tutorial
never submits a swap.

## 1. Install

Clone the repository, then install dependencies with pnpm. Do not use npm or
yarn; they would write a competing lockfile.

```bash
pnpm install
```

## 2. Provide local secrets and vars

`wrangler dev` reads local secrets from a `.dev.vars` file that you create
alongside `wrangler.jsonc`. The server validates four secrets on every request
and refuses to start work without them (see `src/env.ts`). For a local quote,
supply any non-empty placeholder for each:

```
SWAP_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001
AUTH_PASSPHRASE=local-dev-passphrase
UNISWAP_API_KEY=local-dev-key
ETH_RPC_URL=https://rpc.invalid
```

`AUTH_PASSPHRASE` is the passphrase you type on the consent screen in step 4, so
choose one you will remember. The public key, RPC URL, and Uniswap key stay
unused until you execute a real swap, which this tutorial does not.

The non-secret vars (`CHAIN_ID`, `CANONICAL_MCP_URI`, `TRADING_API_BASE_URL`,
and `ALLOWED_ORIGINS`) already carry working defaults in `wrangler.jsonc`.

## 3. Start the dev server

```bash
pnpm dev
```

Wrangler serves the Worker with hot reload, prints a local URL (typically
`http://localhost:8787`), and boots the three Durable Objects. Confirm the
server is up:

```bash
curl http://localhost:8787/healthz
```

You should see `{"status":"ok"}`. This endpoint is public and constant; it
reads no bindings.

## 4. Mint a token through the consent flow

The server is an OAuth 2.1 provider. One operator token authorizes both the
`/mcp` and `/api/*` surfaces. Minting a token is a four-step dance: register a
client, request authorization, approve on the consent screen, then exchange the
code. The integration helper `test/helpers/mintToken.ts` performs exactly these
steps in code; the walkthrough below mirrors it with `curl`.

First, register a public client through open Dynamic Client Registration:

```bash
curl -s http://localhost:8787/register \
  -H 'content-type: application/json' \
  -d '{
    "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
    "token_endpoint_auth_method": "none",
    "client_name": "tutorial-client"
  }'
```

Copy the `client_id` from the response. Because the client is public, the
provider enforces PKCE: generate a code verifier and its S256 challenge, then
open `/authorize` with `response_type=code`, your `client_id`, the same
`redirect_uri`, `resource` set to `CANONICAL_MCP_URI` (the origin), `scope=swap:read
swap:write`, and the PKCE challenge. A real MCP client (e.g. the Claude connector)
does not hardcode this — it auto-discovers the same origin `resource` from the
server's protected-resource metadata (advertised via `resourceMetadata`). Send an
allowed `Origin` header (for
example `https://claude.ai`); the consent flow rejects a request from any origin
outside `ALLOWED_ORIGINS`.

`GET /authorize` returns an HTML consent page. Confirm the client name and
redirect URL match what you expect (this is your out-of-band phishing check),
then read the hidden `csrf_token` field. `POST` back to the same `/authorize`
URL with the `csrf_token` and your `AUTH_PASSPHRASE`, again with the allowed
`Origin`. On success the server responds `302` with the authorization `code` on
the redirect URL.

Exchange that code for a token:

```bash
curl -s http://localhost:8787/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code' \
  -d "code=$CODE" \
  -d 'redirect_uri=https://claude.ai/api/mcp/auth_callback' \
  -d "client_id=$CLIENT_ID" \
  -d "code_verifier=$CODE_VERIFIER"
```

The response carries `access_token`. The grant always includes both
`swap:read` and `swap:write`; the consent flow never issues a narrower scope.

## 5. Run a quote

Call the read-scope REST mirror with your token. `POST /api/quote` returns the
same shape the MCP `get_quote` tool returns:

```bash
curl -s http://localhost:8787/api/quote \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"direction":"ETH_TO_USDC","amountIn":"1000000000000000000"}'
```

A quote binds no funds, so this call is safe to run against the live Trading
API. To run it fully offline, inject a fake Trading API client the way the unit
tests do (see `test/node/swap-service-quote.test.ts`) rather than pointing the
dev server at the network.

A successful response includes `quotedAmountOut`, a decimal-adjusted `price`,
`slippageTolerancePct`, and a `freshUntil` timestamp. You may reuse
`quotedAmountOut` verbatim as `execute_swap`'s `expectedAmountOut` floor.

## Where to go next

- To deploy and manage secrets in production, follow
  [Configure secrets and deploy](../how-to/configure-secrets-and-deploy.md).
- For every tool schema, endpoint, and error code, see the
  [API and data model reference](../reference/api-and-data-model.md).
- To understand why the design looks the way it does, read
  [Architecture decisions](../explanation/architecture-decisions.md).
