# API and data model reference

Technical reference for the swap-mcp surfaces: the MCP tools, the REST
endpoints, the `swaps` data model, and the error allowlist. Every entry is drawn
from the implementation.

## Authentication and transport

Both surfaces sit behind an `OAuthProvider` (`src/index.ts`). A request carries a
bearer token whose grant props hold `{ userId, scopes, resource }`. Every call
enforces, in order, that the token audience (`resource`) equals the canonical
MCP URI and that the token carries the required scope; both fail closed with
`forbidden`.

The `/mcp` transport applies two extra guards before dispatch
(`src/auth/guards.ts`, `transportGuard`): the request `Origin` must be in the
`ALLOWED_ORIGINS` allowlist (else `forbidden`), and an `MCP-Protocol-Version`
header must be present (else `invalid_input`).

Scopes: `swap:read` and `swap:write`. The consent flow always grants both.

## MCP tools

Four tools are registered on the MCP server. Read tools require `swap:read`;
`execute_swap` requires `swap:write`. On failure a tool resolves an error
envelope (`content` text, `structuredContent.error = { code, message }`,
`isError: true`).

### `get_quote`

Fetch a price quote. Requires `swap:read`.

Input (`src/mcp/tools/getQuote.ts`):

| Field       | Type                               | Required |
| ----------- | ---------------------------------- | -------- |
| `direction` | `"ETH_TO_USDC"` \| `"USDC_TO_ETH"` | yes      |
| `amountIn`  | string (base units)                | yes      |

Output (`QuoteResult`): `direction`, `amountIn`, `quotedAmountOut`, `price`
(decimal-adjusted output per 1 input), `slippageTolerancePct`, `createdAt`,
`freshUntil`. Reuse `quotedAmountOut` verbatim as `execute_swap`'s
`expectedAmountOut`.

### `execute_swap`

Execute a swap. Requires `swap:write`.

Input (`src/mcp/tools/executeSwap.ts`):

| Field                  | Type                               | Required |
| ---------------------- | ---------------------------------- | -------- |
| `direction`            | `"ETH_TO_USDC"` \| `"USDC_TO_ETH"` | yes      |
| `amountIn`             | string (base units)                | yes      |
| `expectedAmountOut`    | string (drift floor)               | no       |
| `slippageTolerancePct` | number                             | no       |
| `deadlineSeconds`      | number                             | no       |

The caller's `userId` comes from the token props, never the input. Optional
fields are forwarded only when present. Defaults, applied downstream: slippage
`0.5`% (valid range `0` to `5`, exclusive of `0`), deadline `1200` seconds.

Output (`SwapResult`): `transactionId`; `status` one of `confirmed` | `failed` |
`submitted`; `result` one of `ok` | `timed_out`; and, when available, `txHash`,
`quotedAmountOut`, `actualAmountOut`, `gasUsed`, `errorCode`. A
`{ status: "submitted", result: "timed_out" }` result means the receipt wait
did not settle; the row stays `submitted` (see the reconciliation runbook).

### `get_transaction`

Look up one swap row by id. Requires `swap:read`. Input: `id` (string). Returns
the full swap row; an unknown id yields `not_found`.

### `list_transactions`

List swap rows newest-first with cursor paging. Requires `swap:read`.

Input (`src/mcp/tools/listTransactions.ts`), all optional: `limit` (integer;
the repository caps it to 1–100, default 20), `cursor` (opaque token; a tampered
cursor yields `invalid_input`), `status` (one of `pending` | `submitted` |
`confirmed` | `failed`). Output: `rows` and `nextCursor` (null on the final
page).

## REST endpoints

The REST surface mirrors the tools under `/api` (`src/api/apiApp.ts`). Each
endpoint applies the same audience and scope gates as its MCP twin, and returns
the same payloads. Errors return `{ error: { code, message } }` with the mapped
HTTP status.

| Method & path               | Scope        | Mirrors             |
| --------------------------- | ------------ | ------------------- |
| `POST /api/quote`           | `swap:read`  | `get_quote`         |
| `POST /api/swap`            | `swap:write` | `execute_swap`      |
| `GET /api/transactions`     | `swap:read`  | `list_transactions` |
| `GET /api/transactions/:id` | `swap:read`  | `get_transaction`   |

`POST /api/quote` and `POST /api/swap` take the same JSON body as their tool
inputs. `POST /api/swap` never accepts `userId`: identity comes from the token.
`GET /api/transactions` reads `limit`, `cursor`, and `status` as query
parameters.

The public health check `GET /healthz` returns `{"status":"ok"}` and reads no
bindings.

## Data model: the `swaps` table

One row per swap attempt (`src/db/schema.ts`).

| Column                 | Type    | Notes                                    |
| ---------------------- | ------- | ---------------------------------------- |
| `id`                   | text    | primary key, generated UUID              |
| `userId`               | text    | not null                                 |
| `direction`            | text    | `ETH_TO_USDC` or `USDC_TO_ETH` (checked) |
| `amountIn`             | text    | not null, base units                     |
| `expectedAmountOut`    | text    | nullable caller-supplied drift floor     |
| `quotedAmountOut`      | text    | not null, write-once                     |
| `actualAmountOut`      | text    | nullable, set on confirm                 |
| `slippageTolerancePct` | text    | not null                                 |
| `deadlineSeconds`      | integer | not null                                 |
| `txHash`               | text    | nullable, set on submit                  |
| `status`               | text    | lifecycle state (checked; see below)     |
| `errorCode`            | text    | nullable, set on failure                 |
| `gasUsed`              | text    | nullable, set on confirm                 |
| `createdAt`            | integer | not null, insert time (ms)               |
| `submittedAt`          | integer | nullable, submit time (ms)               |
| `settledAt`            | integer | nullable, terminal time (ms)             |

### Status lifecycle

The `status` column holds exactly one of four values, constrained by a table
check:

- `pending`: inserted, not yet broadcast. No `txHash`.
- `submitted`: broadcast; `txHash` recorded. Terminal only after
  reconciliation if the receipt never settled.
- `confirmed`: receipt succeeded; `actualAmountOut`, `gasUsed`, `settledAt` set.
- `failed`: aborted or reverted; `errorCode`, `settledAt` set. Pre-submit
  aborts leave `txHash` null; post-submit reverts keep it.

`timed_out` is **not** a status. It is a `result` field on the tool/endpoint
response indicating the receipt wait did not settle; the row remains
`submitted`.

### Cursor

The `list` cursor is an opaque base64url token wrapping `{ createdAt, id }`
(`src/repository/cursor.ts`). It is strictly validated on decode; any tampering
throws `invalid_input`. Treat it as opaque: do not construct or parse it.

## Error codes

Every outward-facing error uses one code from this closed allowlist
(`src/errors.ts`). No code outside it is ever exposed. The REST HTTP status for
each is from `src/api/middleware/props.ts`.

| Code                   | HTTP | Meaning                                         |
| ---------------------- | ---- | ----------------------------------------------- |
| `invalid_input`        | 400  | Malformed or out-of-range request.              |
| `unauthorized`         | 401  | Authentication required.                        |
| `forbidden`            | 403  | Caller not permitted (audience or scope).       |
| `not_found`            | 404  | No matching record.                             |
| `slippage_exceeded`    | 409  | Quoted price moved beyond tolerance.            |
| `insufficient_balance` | 409  | Wallet balance too low for the swap.            |
| `approval_required`    | 409  | A token approval is required first.             |
| `upstream_unavailable` | 502  | An upstream service is temporarily unavailable. |
| `rate_limited`         | 429  | Too many requests.                              |
| `swap_failed`          | 502  | The swap did not complete successfully.         |
| `internal`             | 500  | Unexpected internal error.                      |
