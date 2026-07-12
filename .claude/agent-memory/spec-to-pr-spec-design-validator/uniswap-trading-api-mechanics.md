---
name: uniswap-trading-api-mechanics
description: Non-obvious Uniswap Trading API mechanics that specs in this repo get wrong — amountOutMinimum is not caller-controllable, slippage is a percent, routing-shape families
metadata:
  type: project
---

Domain facts verified against the `swap-integration` skill (repo `.claude/skills/swap-integration/SKILL.md`), used when validating the swap-mcp spec.

**Why:** The swap-mcp spec repeatedly claims the service "carries the router-enforced `amountOutMinimum`" in the `/swap` body. That is false for the Trading API path (the integration method the spec chose).
**How to apply:** When a spec uses the Uniswap **Trading API** (`/check_approval` → `/quote` → `/swap`), check these:

- `amountOutMinimum` is NOT a request field on `/quote` or `/swap`. It is only a Universal-Router-SDK manual-command parameter (a DIFFERENT integration method). In the Trading API path the on-chain min-out floor is set implicitly by the `slippageTolerance` **percent** sent to `/quote`; the API bakes it into the opaque calldata returned by `/swap`. The service never computes or "carries" `amountOutMinimum`. A spec claiming to multiply `fresh × (1 − tol)` and carry it is describing the SDK path, not the API path.
- `slippageTolerance` on `/quote` is a **percent** in `[0,100]` (e.g. `0.5`), not a fraction.
- `/quote` response shape is a discriminated union on `routing`. `CLASSIC | WRAP | UNWRAP` share `quote.output.amount`. `DUTCH_V2 | DUTCH_V3 | PRIORITY` (UniswapX) have NO `quote.output` — output lives at `quote.orderInfo.outputs[0].startAmount`. A routing-aware accessor asserting `∈ {CLASSIC,WRAP,UNWRAP}` and reading `quote.output.amount` is correct and matches the skill's `ClassicQuoteResponse` union.
- `/swap` response is nested: `{ swap: { to, from, data, value, chainId, gasLimit } }`.
- `/swap` request = quote response **spread** into body (not wrapped in `{quote}`), with `permitData`/`permitTransaction` stripped when null.
- `/check_approval` returns `{ approval: {...} | null }`; null = already approved.
- For ETH↔USDC on mainnet the real route is always a genuine CLASSIC swap; WRAP/UNWRAP are pure ETH↔WETH conversions and won't be returned for a token swap — but keeping them in the assertion set is harmless.
- `/swap` response is nested `{ swap: { to, from, data, value, chainId, gasLimit } }`. The API supplies the tx `value` (native ETH for ETH_TO_USDC) — the service carries it, never re-derives it. `buildSwap` must UNWRAP `response.swap`.

**viem receipt semantics (verified via context7 /wevm/viem, 2026-07):** `waitForTransactionReceipt({ hash, timeout })` — on TIMEOUT throws `WaitForTransactionReceiptTimeoutError`; on REVERT it RESOLVES with a receipt whose `status === "reverted"` (it does NOT throw on revert — `throwOnReceiptRevert` is an opt-in only on the `*Sync` action variants, not on `waitForTransactionReceipt`). So a correct disambiguation reads receipt.status for success/reverted and catches only the timeout throw. Any OTHER thrown error (RPC/replacement/network) is a third bucket the plan's 3-way ReceiptOutcome does not model — flag as a gap.

**gasLimit availability trap:** In the Trading API path the only gas-limit value is `SwapTx.gasLimit` from the `/swap` response (buildSwap). A gas-headroom balance rail of the form `amountIn + gasLimit × maxFeePerGas` cannot run BEFORE buildSwap. Spec §5.8 orders rails (step 5) before buildSwap (step 6) — a latent contradiction unless the rail runs post-buildSwap or a separate gas-limit estimate seam is added.
