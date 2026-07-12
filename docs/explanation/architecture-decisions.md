# Architecture decisions

This document explains why swap-mcp is built the way it is. It discusses the
trade-offs behind the OAuth provider, the coordination model, the drift rails,
and the custodial stance. It is background reading, not a task list.

## OAuthProvider plus McpAgent

The Worker's entry point is a Cloudflare `OAuthProvider` that owns discovery,
token issuance, and open Dynamic Client Registration, and guards two protected
surfaces — `/mcp` and `/api/*` — behind a bearer token
(`src/index.ts`). `/mcp` is served by an `McpAgent`, which the Agents SDK
resolves to a Durable Object by binding name.

Using the provider frees the application from implementing the OAuth 2.1 + PKCE
dance, token storage, and audience checks by hand. The canonical resource is
**origin-only** (no `/mcp` path) on purpose: the provider's audience match
accepts any path under an origin-only audience, so one operator token authorizes
both `/mcp` and `/api/*`. A path-scoped audience would reject every `/api/*`
request. The consent flow always grants both `swap:read` and `swap:write`
(interview decision 26); it never derives scope from the client's request, so a
client cannot widen its own grant.

## A RateLimiter Durable Object, not KV

The consent passphrase compare is guarded by a failure-budget rate limiter
(`src/ratelimit/RateLimiter.ts`): 5 failures per IP and 20 globally, over a
fixed 10-minute window. It is a Durable Object rather than KV because the
ceiling must hold under concurrency. The check is a read-modify-write across
several storage awaits, wrapped in `blockConcurrencyWhile` so two concurrent
calls cannot both read the same pre-increment count and leak past the ceiling.
KV's eventual consistency gives no such guarantee. The budget is fail-safe-
closed: a reservation is consumed at check time, so a caller that never reports
an outcome still counts against the budget. The global ceiling can briefly lock
all operators out; that tradeoff is covered in the deploy how-to.

## SwapCoordinator and single-swap serialization

Execution funnels through a single-user `SwapCoordinator` Durable Object
(`src/coordinator/SwapCoordinator.ts`). Because one custodial wallet signs every
swap, two swaps must never build and broadcast concurrently — overlapping
submissions would race on the wallet nonce. The coordinator serializes calls by
chaining each `executeSwap` onto the previous call's settlement through an
in-memory promise tail (`#tail`), so call N+1 begins its engine work only after
call N settles.

### The mutex does not survive eviction

The `#tail` mutex is an in-memory, per-live-instance primitive. It serializes
only within one running Durable Object instance and **does not survive DO
eviction or hibernation** — a re-instantiated object starts with a fresh,
resolved tail. Do not overstate its guarantee: cross-eviction safety does **not**
rest on this mutex. It rests on the single-in-flight-swap invariant (one wallet,
one swap at a time) plus D1 reconciliation of any row stranded in `submitted`.
The mutex is a within-instance ordering aid, not a durable lock.

## Drift-floor semantics: caller floor versus API-embedded floor

The engine runs two distinct slippage protections, and they must not double-
count (`src/services/rails.ts`, `checkDrift`). The Trading API embeds a slippage
floor directly in the swap calldata; that floor always applies. Separately, a
caller may pass `expectedAmountOut` as an explicit floor. The drift rail fires
**only** when the caller supplies `expectedAmountOut`: it computes a bigint floor
from integer basis points and aborts with `slippage_exceeded` if the fresh quote
falls below it. When the caller omits `expectedAmountOut`, the drift rail never
aborts, leaving the API-embedded floor as the sole rail. Applying a second local
floor in that case would double-count slippage.

## The `approval_required` no-auto-send stance

A `USDC_TO_ETH` swap needs a Universal Router allowance on USDC. When
`/check_approval` reports the allowance is missing, the service aborts with
`approval_required` and **never sends the approval itself**
(`src/services/swapService.ts`). An approval is a distinct, user-authorized
transaction that grants a spender control over the wallet's funds; auto-sending
it would exceed the mandate of a swap. Recovery is an out-of-band operator
action, documented in the one-time approval how-to.

## Custodial trade-offs

The server holds one private key and swaps on behalf of a single user. This is
simple and fast — no per-user key management, no external signing round-trips —
but concentrates risk: the key is a single point of compromise, and the single
wallet is why swaps must serialize. The design leans into this rather than
hiding it: secrets are exposed only through lazy accessor closures, never stored
as object fields, so a snapshot of the coordinator or its deps leaks no key
material; and logs carry only allowlisted, non-secret fields.

## Why `timed_out` is a result, not a row status

The `swaps` table has four statuses: `pending`, `submitted`, `confirmed`,
`failed`. A receipt-wait timeout is deliberately **not** a fifth status. When the
wait times out or the outcome is unknown, the transaction is live and may still
confirm, so writing a terminal state would fabricate an outcome the chain has
not delivered. The row stays `submitted`; the call reports `result: "timed_out"`
to tell the caller the wait did not settle. Reconciliation later reads the chain
and closes the row honestly. Encoding the undetermined outcome as a call result,
not a persisted status, keeps the stored lifecycle truthful.
