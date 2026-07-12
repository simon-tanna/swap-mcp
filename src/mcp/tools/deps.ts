import type { AuthProps } from "../../auth/guards";
import type { SwapDirection } from "../../engine/tradingApiClient";
import type { ExecuteSwapInput } from "../../services/rails";
import type { QuoteResult, SwapResult } from "../../services/swapService";
import type { TransactionsRepository } from "../../repository/transactions";

/**
 * Everything the read/execute tool registrars need, injected so the tools stay
 * pure and unit-testable. `coordinator` is carried even though the read tools
 * never touch it — the execute tool does, and pinning the shape now keeps
 * `ToolDeps` stable across the whole tool suite.
 */
export type ToolDeps = {
  /** Per-request auth context; a thunk so a single registration serves every call. */
  getProps: () => AuthProps;
  /** The canonical MCP URI every token's audience must match (fail-closed). */
  canonicalMcpUri: string;
  /**
   * Read-path service surface. `getQuote` is the swap service's `getQuote`
   * already bound to its engine deps (`tradingApi`/`now`) by the wiring layer,
   * so tools invoke it with just the caller input — they never construct or
   * hold a `TradingApiClient` themselves.
   */
  service: {
    getQuote: (input: {
      direction: SwapDirection;
      amountIn: string;
    }) => Promise<QuoteResult>;
  };
  /** Write-path executor, reached via the Durable Object; unused by read tools. */
  coordinator: {
    executeSwap(p: ExecuteSwapInput & { userId: string }): Promise<SwapResult>;
  };
  /** Persistence port for transaction lookup and listing. */
  repo: TransactionsRepository;
};
