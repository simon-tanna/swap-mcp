import { scrubHex } from "./log";

/** Closed allowlist of outward-facing error codes; no code outside this tuple is ever exposed. */
export const ERROR_CODES = [
  "invalid_input",
  "unauthorized",
  "forbidden",
  "not_found",
  "slippage_exceeded",
  "insufficient_balance",
  "approval_required",
  "upstream_unavailable",
  "rate_limited",
  "swap_failed",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The MCP tool-result error envelope: text content plus structured error and the error flag. */
export type ErrorEnvelope = {
  content: [{ type: "text"; text: string }];
  structuredContent: { error: { code: ErrorCode; message: string } };
  isError: true;
};

/** Application error carrying an allowlisted code and an optional curated public message. */
export class AppError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, publicMessage?: string) {
    super(publicMessage ?? code);
    this.name = "AppError";
    this.code = code;
  }
}

/** Map any thrown value to an allowlisted code; unknown or non-AppError values become "internal". */
export function classify(err: unknown): ErrorCode {
  return err instanceof AppError ? err.code : "internal";
}

/**
 * Curated, caller-safe messages for every allowlisted error code. Shared
 * between the MCP tool envelopes (`guarded.ts`) and the REST error mapping
 * (`api/middleware/props.ts`) so both surfaces expose byte-identical, non-leaking text.
 */
export const CURATED_MESSAGE: Record<ErrorCode, string> = {
  invalid_input: "The request was malformed or out of range.",
  unauthorized: "Authentication is required.",
  forbidden: "The caller is not permitted to perform this action.",
  not_found: "No matching record was found.",
  slippage_exceeded: "The quoted price moved beyond the allowed tolerance.",
  insufficient_balance: "The wallet balance is insufficient for this swap.",
  approval_required: "A token approval is required before this swap.",
  upstream_unavailable: "An upstream service is temporarily unavailable.",
  rate_limited: "Too many requests; please retry later.",
  swap_failed: "The swap did not complete successfully.",
  internal: "An unexpected internal error occurred.",
};

/** Build the MCP error envelope from an allowlisted code and a curated public message. */
export function toErrorEnvelope(
  code: ErrorCode,
  publicMessage: string,
): ErrorEnvelope {
  const message = scrubHex(publicMessage);
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
}
