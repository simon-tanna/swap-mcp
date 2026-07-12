import { describe, expect, test } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { AppError } from "../../src/errors";
import { USDC_ADDRESS } from "../../src/engine/constants";
import {
  createViemSigner,
  type ClientFactory,
  type SignerClients,
} from "../../src/engine/viemSigner";
import {
  makeNonTimeoutError,
  makeTimeoutError,
  receiptReverted,
  receiptSuccess,
} from "../fixtures/receipts";

// Anvil account #0 private key — a well-known test key, never a real secret.
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = privateKeyToAccount(TEST_PRIVATE_KEY).address;
const RPC_URL = "https://rpc.example.invalid";
const HOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const HASH =
  "0x4ca7ee652d57678f26e887c149ab0735f41de37bcad58c9f6d3ed5824f15b74d";

/** Records of what each fake client method was invoked with. */
type FakeCalls = {
  factory: number;
  getBalance: unknown[];
  readContract: unknown[];
  estimateMaxFeePerGas: number;
  sendTransaction: unknown[];
  waitForTransactionReceipt: unknown[];
};

/** Build a `clientFactory` returning fake public/wallet clients, counting each call. */
function makeFactory(opts: {
  balance?: bigint;
  erc20Balance?: bigint;
  erc20Raw?: unknown;
  feeEstimate?: bigint;
  hash?: string;
  waitResult?: () => Promise<{ status: string; gasUsed?: bigint }>;
}): { factory: ClientFactory; calls: FakeCalls } {
  const calls: FakeCalls = {
    factory: 0,
    getBalance: [],
    readContract: [],
    estimateMaxFeePerGas: 0,
    sendTransaction: [],
    waitForTransactionReceipt: [],
  };
  const factory: ClientFactory = () => {
    calls.factory += 1;
    const clients: SignerClients = {
      public: {
        getBalance: async (args) => {
          calls.getBalance.push(args);
          return opts.balance ?? 0n;
        },
        readContract: async (args) => {
          calls.readContract.push(args);
          if ("erc20Raw" in opts) return opts.erc20Raw;
          return opts.erc20Balance ?? 0n;
        },
        estimateMaxFeePerGas: async () => {
          calls.estimateMaxFeePerGas += 1;
          return opts.feeEstimate ?? 0n;
        },
        waitForTransactionReceipt: async (args) => {
          calls.waitForTransactionReceipt.push(args);
          return opts.waitResult ? await opts.waitResult() : receiptSuccess;
        },
      },
      wallet: {
        sendTransaction: async (args) => {
          calls.sendTransaction.push(args);
          return opts.hash ?? HASH;
        },
      },
    };
    return clients;
  };
  return { factory, calls };
}

function makeSigner(overrides: Parameters<typeof makeFactory>[0]) {
  const { factory, calls } = makeFactory(overrides);
  const signer = createViemSigner({
    getPrivateKey: () => TEST_PRIVATE_KEY,
    getRpcUrl: () => RPC_URL,
    clientFactory: factory,
  });
  return { signer, calls };
}

describe("ViemSigner", () => {
  test("getNativeBalance reads native ETH via getBalance", async () => {
    const { signer, calls } = makeSigner({ balance: 5n * 10n ** 18n });
    const balance = await signer.getNativeBalance(HOLDER);
    expect(balance).toBe(5n * 10n ** 18n);
    expect(calls.getBalance).toHaveLength(1);
    expect(calls.getBalance[0]).toEqual({ address: HOLDER });
  });

  test("getErc20Balance reads USDC balanceOf", async () => {
    const { signer, calls } = makeSigner({ erc20Balance: 1_000_000n });
    const balance = await signer.getErc20Balance(USDC_ADDRESS, HOLDER);
    expect(balance).toBe(1_000_000n);
    expect(calls.readContract).toHaveLength(1);
    const args = calls.readContract[0] as Record<string, unknown>;
    expect(args.address).toBe(USDC_ADDRESS);
    expect(args.functionName).toBe("balanceOf");
    expect(args.args).toEqual([HOLDER]);
  });

  test("getErc20Balance rejects a non-bigint readContract result", async () => {
    // A malformed/unexpected ABI decode must fail closed at the untrusted boundary,
    // never propagate a non-bigint typed as bigint into money-path comparisons.
    for (const raw of ["1000000", undefined, null, 123]) {
      const { signer } = makeSigner({ erc20Raw: raw });
      const err = await signer
        .getErc20Balance(USDC_ADDRESS, HOLDER)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("upstream_unavailable");
    }
  });

  test("sendTransaction signs and submits returning the hash", async () => {
    const { signer, calls } = makeSigner({ hash: HASH });
    const hash = await signer.sendTransaction({
      to: USDC_ADDRESS,
      data: "0xfeed",
      value: "1000000000000000000",
    });
    expect(hash).toBe(HASH);
    expect(calls.sendTransaction).toHaveLength(1);
    const tx = calls.sendTransaction[0] as Record<string, unknown>;
    expect(tx.to).toBe(USDC_ADDRESS);
    expect(tx.data).toBe("0xfeed");
    // Value threaded through as a bigint (wei).
    expect(tx.value).toBe(1000000000000000000n);
    // Account derived from the test key resolves to the expected address.
    const account = tx.account as { address: string };
    expect(account.address).toBe(TEST_ADDRESS);

    // The private key never lives on the signer object.
    expect(JSON.stringify(signer)).not.toContain(TEST_PRIVATE_KEY);
    expect(JSON.stringify(signer)).not.toContain(TEST_PRIVATE_KEY.slice(2));
    expect(signer.address).toBe(TEST_ADDRESS);
  });

  test("waitForReceipt distinguishes success, revert, timeout and a non-timeout throw (unknown)", async () => {
    const ok = makeSigner({ waitResult: async () => receiptSuccess });
    expect(await ok.signer.waitForReceipt(HASH, 8000)).toEqual({
      kind: "success",
      gasUsed: receiptSuccess.gasUsed,
    });
    // Timeout passed through to the client action.
    expect(ok.calls.waitForTransactionReceipt[0]).toEqual({
      hash: HASH,
      timeout: 8000,
    });

    const reverted = makeSigner({ waitResult: async () => receiptReverted });
    expect(await reverted.signer.waitForReceipt(HASH, 8000)).toEqual({
      kind: "reverted",
    });

    const timedOut = makeSigner({
      waitResult: async () => {
        throw makeTimeoutError();
      },
    });
    expect(await timedOut.signer.waitForReceipt(HASH, 8000)).toEqual({
      kind: "timeout",
    });

    // A non-timeout throw (RPC / receipt-not-found / unnamed) collapses to unknown,
    // never to reverted or timeout.
    const unknownNamed = makeSigner({
      waitResult: async () => {
        throw makeNonTimeoutError();
      },
    });
    expect(await unknownNamed.signer.waitForReceipt(HASH, 8000)).toEqual({
      kind: "unknown",
    });

    const unknownBare = makeSigner({
      waitResult: async () => {
        throw new Error("some RPC failure");
      },
    });
    expect(await unknownBare.signer.waitForReceipt(HASH, 8000)).toEqual({
      kind: "unknown",
    });
  });

  test("waitForReceipt returns unknown when a success receipt omits gasUsed", async () => {
    // A genuine success receipt always carries gasUsed; a missing value signals a
    // malformed/partial receipt and must not be fabricated as a zero-gas success.
    const { signer } = makeSigner({
      waitResult: async () => ({ status: "success" }),
    });
    expect(await signer.waitForReceipt(HASH, 8000)).toEqual({
      kind: "unknown",
    });
  });

  test("clients are created per call, not at module scope", async () => {
    const { signer, calls } = makeSigner({});
    expect(calls.factory).toBe(0);
    await signer.getNativeBalance(HOLDER);
    expect(calls.factory).toBe(1);
    await signer.getErc20Balance(USDC_ADDRESS, HOLDER);
    expect(calls.factory).toBe(2);
    await signer.estimateMaxFeePerGas();
    expect(calls.factory).toBe(3);
    await signer.sendTransaction({ to: HOLDER, data: "0x", value: "0" });
    expect(calls.factory).toBe(4);
    await signer.waitForReceipt(HASH, 8000);
    expect(calls.factory).toBe(5);
  });

  test("estimateMaxFeePerGas surfaces the fee estimate", async () => {
    const { signer, calls } = makeSigner({ feeEstimate: 42_000_000_000n });
    const fee = await signer.estimateMaxFeePerGas();
    expect(fee).toBe(42_000_000_000n);
    expect(calls.estimateMaxFeePerGas).toBe(1);
  });
});
