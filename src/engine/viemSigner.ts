import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { AppError } from "../errors";

const ERC20_BALANCE_OF_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

/** viem's error name when `waitForTransactionReceipt` times out. */
const WAIT_TIMEOUT_ERROR_NAME = "WaitForTransactionReceiptTimeoutError";

/** Disambiguated result of waiting for a receipt; only a genuine revert receipt yields "reverted". */
export type ReceiptOutcome =
  | { kind: "success"; gasUsed: bigint }
  | { kind: "reverted" }
  | { kind: "timeout" }
  | { kind: "unknown" };

export interface PublicClientLike {
  getBalance(args: { address: string }): Promise<bigint>;
  readContract(args: {
    address: string;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
  estimateMaxFeePerGas(): Promise<bigint>;
  waitForTransactionReceipt(args: {
    hash: string;
    timeout: number;
  }): Promise<{ status: string; gasUsed?: bigint }>;
}

export interface WalletClientLike {
  sendTransaction(args: {
    account: unknown;
    to: string;
    data: string;
    value: bigint;
  }): Promise<string>;
}

export interface SignerClients {
  public: PublicClientLike;
  wallet: WalletClientLike;
}

/** Builds a fresh client pair per request; injected in tests, defaulted to real viem clients. */
export type ClientFactory = (config: {
  rpcUrl: string;
  account: ReturnType<typeof privateKeyToAccount>;
}) => SignerClients;

/** Signs and submits transactions and reads direction-aware balances, without retaining key material. */
export interface ViemSigner {
  /** Derived signer address, exposed publicly with no key material retained. */
  address: string;
  /** Read the native ETH balance (18-decimal input source for ETH→USDC). */
  getNativeBalance(addr: string): Promise<bigint>;
  /** Read an ERC-20 balance via `balanceOf` (e.g. 6-decimal USDC input source for USDC→ETH). */
  getErc20Balance(token: string, addr: string): Promise<bigint>;
  /** Current max-fee-per-gas estimate (wei), consumed by the gas-headroom rail. */
  estimateMaxFeePerGas(): Promise<bigint>;
  /** Sign with the call-time-derived account and submit, returning the tx hash. */
  sendTransaction(tx: {
    to: string;
    data: string;
    value: string;
  }): Promise<string>;
  waitForReceipt(hash: string, timeoutMs: number): Promise<ReceiptOutcome>;
}

const defaultClientFactory: ClientFactory = ({ rpcUrl, account }) => ({
  public: createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  }) as unknown as PublicClientLike,
  wallet: createWalletClient({
    account,
    chain: mainnet,
    transport: http(rpcUrl),
  }) as unknown as WalletClientLike,
});

/** Create a signer whose private key is derived at call time and never stored on the returned object. */
export function createViemSigner(deps: {
  getPrivateKey: () => string;
  getRpcUrl: () => string;
  clientFactory?: ClientFactory;
}): ViemSigner {
  const factory = deps.clientFactory ?? defaultClientFactory;

  const address = privateKeyToAccount(
    deps.getPrivateKey() as `0x${string}`,
  ).address;

  // Build clients per method call (Workers-isolate constraint), deriving the key freshly each time.
  function clients(): SignerClients & {
    account: ReturnType<typeof privateKeyToAccount>;
  } {
    const account = privateKeyToAccount(deps.getPrivateKey() as `0x${string}`);
    return { account, ...factory({ rpcUrl: deps.getRpcUrl(), account }) };
  }

  return {
    address,

    async getNativeBalance(addr) {
      return clients().public.getBalance({ address: addr });
    },

    async getErc20Balance(token, addr) {
      const result = await clients().public.readContract({
        address: token,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [addr],
      });
      // Validate at the untrusted RPC boundary: a malformed ABI decode is an upstream fault,
      // never a non-bigint silently propagated into money-path balance comparisons.
      if (typeof result !== "bigint") {
        throw new AppError(
          "upstream_unavailable",
          "malformed balance response",
        );
      }
      return result;
    },

    async estimateMaxFeePerGas() {
      return clients().public.estimateMaxFeePerGas();
    },

    async sendTransaction(tx) {
      const { account, wallet } = clients();
      return wallet.sendTransaction({
        account,
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value),
      });
    },

    async waitForReceipt(hash, timeoutMs) {
      try {
        const receipt = await clients().public.waitForTransactionReceipt({
          hash: hash as Hash,
          timeout: timeoutMs,
        });
        if (receipt.status === "success") {
          // A genuine success receipt always carries gasUsed; a missing/non-bigint value
          // signals a malformed receipt and collapses to the conservative unknown outcome
          // rather than fabricating a zero-gas success into the gas rail.
          if (typeof receipt.gasUsed !== "bigint") {
            return { kind: "unknown" };
          }
          return { kind: "success", gasUsed: receipt.gasUsed };
        }
        if (receipt.status === "reverted") {
          return { kind: "reverted" };
        }
        return { kind: "unknown" };
      } catch (err) {
        if (err instanceof Error && err.name === WAIT_TIMEOUT_ERROR_NAME) {
          return { kind: "timeout" };
        }
        return { kind: "unknown" };
      }
    },
  };
}
