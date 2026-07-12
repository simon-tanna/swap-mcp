# Run the one-time USDC approval

This guide fixes a `USDC_TO_ETH` swap that keeps failing with
`approval_required`. You run a single, out-of-band ERC-20 `approve` transaction
from the swap wallet, then retry the swap. You do this once per wallet.

## When you need it

A `USDC_TO_ETH` swap spends USDC, an ERC-20 token, and the Uniswap Universal
Router must hold an allowance to move it. Native ETH input has no allowance
concept, so `ETH_TO_USDC` swaps never hit this path.

Before submitting, the service calls the Trading API's `/check_approval`
(`src/services/swapService.ts`). When the router lacks sufficient allowance,
`check_approval` returns a non-null `approval`, and the service aborts the swap
with the `approval_required` error code. It records the attempt as a `failed`
row and stops.

**The service never sends the approval for you.** An approval is a separate,
user-authorized transaction that moves the wallet's own funds under a spender's
control, so the service deliberately refuses to auto-send it. Clearing the block
is your out-of-band action.

## Send the approval

From the swap wallet (the account behind `SWAP_PRIVATE_KEY`), send one
legacy ERC-20 `approve` on mainnet USDC granting the Universal Router an
allowance:

- **Token (USDC):** `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- **Spender (Universal Router):** `0x66a9893cc07d91d95644aedd05d03f95e1dba8af`
- **Amount:** enough to cover the swaps you intend; a large or max allowance
  avoids repeating this step for every trade.

Both addresses are pinned in `src/engine/constants.ts`. Use any wallet or script
you trust to sign and broadcast the `approve` call; this action lives entirely
outside the service.

Wait for the `approve` transaction to confirm on-chain before continuing.

## Retry the swap

Once the allowance is set, resubmit the same `USDC_TO_ETH` swap through
`execute_swap` (MCP) or `POST /api/swap` (REST). The next `/check_approval` now
returns a null `approval`, the gate passes, and the swap proceeds to the
balance and gas rails. The earlier `approval_required` row stays `failed` for
audit; the retry creates a fresh row.
