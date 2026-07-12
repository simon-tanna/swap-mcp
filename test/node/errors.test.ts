import { describe, expect, test } from "vitest";
import {
  AppError,
  ERROR_CODES,
  classify,
  toErrorEnvelope,
} from "../../src/errors";

describe("errors", () => {
  test("ErrorCode allowlist is closed and exact", () => {
    expect(ERROR_CODES).toEqual([
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
    ]);
    expect(ERROR_CODES).not.toContain("quote_expired");
    expect(ERROR_CODES).toContain("approval_required");
  });

  test("classify maps AppError and unknown errors", () => {
    expect(classify(new AppError("slippage_exceeded"))).toBe(
      "slippage_exceeded",
    );
    expect(classify(new Error("boom"))).toBe("internal");
    expect(classify("junk")).toBe("internal");
  });

  test("toErrorEnvelope produces the MCP envelope shape", () => {
    const envelope = toErrorEnvelope("invalid_input", "bad amount");
    expect(envelope).toEqual({
      content: [{ type: "text", text: expect.any(String) }],
      structuredContent: { error: { code: "invalid_input", message: "bad amount" } },
      isError: true,
    });

    // Raw internal error detail must never leak into the outward envelope.
    const code = classify(new Error("secret-detail"));
    const curated = toErrorEnvelope(code, "An internal error occurred.");
    expect(JSON.stringify(curated)).not.toContain("secret-detail");
  });
});
