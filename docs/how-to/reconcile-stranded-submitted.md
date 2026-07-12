# Reconcile a stranded submitted swap

This runbook resolves a swap row stuck in the `submitted` state. You look up its
recorded transaction hash on-chain, determine the real outcome, and mark the row
`confirmed` or `failed` to match reality.

## Why a row strands in `submitted`

The swap engine advances a row `pending` → `submitted` → `confirmed`/`failed` as
it works (`src/services/swapService.ts`). After broadcasting the transaction it
waits for a receipt, bounded by the swap's deadline. Two outcomes leave the row
`submitted`:

- The receipt wait times out, or the outcome is unknown. The transaction may
  still confirm later.
- A post-broadcast bookkeeping write throws while the transaction is live.

In both cases the engine refuses to write `failed` for an undetermined outcome
(the transaction is real and may succeed), so the row stays `submitted` with its
`txHash` recorded. The tool call returns `result: "timed_out"`, which is a call
outcome, not a row state. Reconciliation closes these rows once the chain
settles.

## Step 1: Read the row

Fetch the row through `GET /api/transactions/:id` (REST) or the
`get_transaction` MCP tool. Note its `status`, `txHash`, `direction`,
`amountIn`, and `quotedAmountOut`.

**A `pending` row with no `txHash` is safe to mark `failed`.** Nothing was ever
broadcast (the engine advances to `submitted` only after `sendTransaction`
returns a hash), so no on-chain transaction can exist for it, and closing it
`failed` risks nothing. Only rows that carry a `txHash` require the on-chain
lookup below.

## Step 2: Look up the txHash on-chain

Query a mainnet explorer or RPC node for the transaction receipt at the row's
`txHash`. The receipt tells you the real outcome:

- **Confirmed and succeeded**: the receipt exists with success status.
- **Reverted**: the receipt exists with a failure status.
- **Still pending or dropped**: no receipt yet, or the transaction has fallen
  out of the mempool.

If the transaction is still pending, wait and re-check; do not reconcile an
in-flight transaction.

## Step 3: Mark the row to match the chain

Update the row through your D1 tooling to reflect the settled outcome. The
lifecycle columns live in the `swaps` table (`src/db/schema.ts`).

- **Succeeded**: set `status = 'confirmed'`, record `actualAmountOut` (the
  received output; absent an on-chain decoder, the recorded `quotedAmountOut` is
  the best available value) and `gasUsed` from the receipt, and stamp
  `settledAt`.
- **Reverted**: set `status = 'failed'`, set `errorCode = 'swap_failed'`, keep
  the `txHash`, and stamp `settledAt`.
- **Dropped and never mined**: set `status = 'failed'` with an `errorCode` that
  reflects the cause (for example `swap_failed`), and stamp `settledAt`.

Use only error codes from the allowlist; see the
[API and data model reference](../reference/api-and-data-model.md#error-codes)
for the full set.

After the update the row is terminal (`confirmed` or `failed`) and matches the
chain. Never mark a row `confirmed` without a success receipt, and never mark a
`submitted` row `failed` without confirming the transaction reverted or dropped.
