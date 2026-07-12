/** A minimal viem-shaped transaction receipt indicating on-chain success. */
export const receiptSuccess = {
  status: "success" as const,
  gasUsed: 21000n,
  blockNumber: 1234567n,
  transactionHash:
    "0x4ca7ee652d57678f26e887c149ab0735f41de37bcad58c9f6d3ed5824f15b74d",
};

/** A minimal viem-shaped transaction receipt indicating an on-chain revert. */
export const receiptReverted = {
  status: "reverted" as const,
  gasUsed: 21000n,
  blockNumber: 1234568n,
  transactionHash:
    "0x5ca7ee652d57678f26e887c149ab0735f41de37bcad58c9f6d3ed5824f15b74e",
};

/** The name viem gives the error thrown when `waitForTransactionReceipt` times out. */
export const WAIT_TIMEOUT_ERROR_NAME = "WaitForTransactionReceiptTimeoutError";

/** Build the timeout-throw variant: an error whose `.name` matches viem's timeout error. */
export function makeTimeoutError(): Error {
  const err = new Error("timed out while waiting for transaction receipt");
  err.name = WAIT_TIMEOUT_ERROR_NAME;
  return err;
}

/** Build a non-timeout throw variant (an RPC/receipt-not-found style error) that must map to "unknown". */
export function makeNonTimeoutError(): Error {
  const err = new Error("transaction receipt not found");
  err.name = "TransactionReceiptNotFoundError";
  return err;
}
