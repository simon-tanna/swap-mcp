import type {
  ClassicQuoteResponse,
  SwapDirection,
  SwapTx,
  TradingApiClient,
} from "../../../src/engine/tradingApiClient";
import type {
  ReceiptOutcome,
  ViemSigner,
} from "../../../src/engine/viemSigner";
import type { SwapServiceDeps } from "../../../src/services/swapService";
import { quoteClassic, swapNested } from "../../fixtures/tradingApi";

/** Pinned signer address for the fake signer, distinct from the quote fixtures' swapper. */
export const SIGNER_ADDRESS = "0x3333333333333333333333333333333333333333";
/** A plausible broadcast tx hash returned by the fake signer's sendTransaction. */
export const TX_HASH =
  "0x4ca7ee652d57678f26e887c149ab0735f41de37bcad58c9f6d3ed5824f15b74d";

/** Happy-path ETH→USDC input; native input needs no approval gate. */
export function ethToUsdcInput(): {
  direction: SwapDirection;
  amountIn: string;
  userId: string;
} {
  return {
    direction: "ETH_TO_USDC",
    amountIn: "1000000000000000000",
    userId: "user-1",
  };
}

/** Overridable hooks for the fake TradingApiClient so tests can drive approval/quote/swap. */
export type FakeTradingApiOpts = {
  checkApproval?: TradingApiClient["checkApproval"];
  getQuote?: TradingApiClient["getQuote"];
  buildSwap?: TradingApiClient["buildSwap"];
};

/** A fake TradingApiClient serving the CLASSIC quote/swap fixtures by default; all hooks injectable. */
export function fakeTradingApi(
  opts: FakeTradingApiOpts = {},
): TradingApiClient {
  return {
    checkApproval:
      opts.checkApproval ??
      (async () => {
        return { approval: null };
      }),
    getQuote:
      opts.getQuote ??
      (async () => {
        return quoteClassic as unknown as ClassicQuoteResponse;
      }),
    buildSwap:
      opts.buildSwap ??
      (async () => {
        return { ...swapNested.swap } as SwapTx;
      }),
  };
}

/** Overridable hooks for the fake signer so individual tests can drive send/wait/balance. */
export type FakeSignerOpts = {
  sendTransaction?: (tx: {
    to: string;
    data: string;
    value: string;
  }) => Promise<string>;
  waitForReceipt?: (hash: string, timeoutMs: number) => Promise<ReceiptOutcome>;
  getNativeBalance?: (address: string) => Promise<bigint>;
};

/** A fake ViemSigner with generous default balances; send/wait/balance are injectable per test. */
export function fakeSigner(opts: FakeSignerOpts = {}): ViemSigner {
  return {
    address: SIGNER_ADDRESS,
    getNativeBalance:
      opts.getNativeBalance ??
      (async () => {
        return 10n ** 30n;
      }),
    async getErc20Balance() {
      return 10n ** 30n;
    },
    async estimateMaxFeePerGas() {
      return 1n;
    },
    sendTransaction:
      opts.sendTransaction ??
      (async () => {
        return TX_HASH;
      }),
    waitForReceipt:
      opts.waitForReceipt ??
      (async () => {
        return { kind: "success", gasUsed: 21000n };
      }),
  };
}

/** Assemble injectable deps from fakes plus the REAL repository, so D1 is genuinely written. */
export function makeDeps(
  signer: ViemSigner,
  repo: SwapServiceDeps["repo"],
  tradingApi: TradingApiClient = fakeTradingApi(),
): SwapServiceDeps {
  return { tradingApi, signer, repo };
}
