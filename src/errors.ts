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

/** A single member of the closed error-code allowlist. */
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

/** Build the MCP error envelope from an allowlisted code and a curated public message. */
export function toErrorEnvelope(
  code: ErrorCode,
  publicMessage: string,
): ErrorEnvelope {
  return {
    content: [{ type: "text", text: publicMessage }],
    structuredContent: { error: { code, message: publicMessage } },
    isError: true,
  };
}
