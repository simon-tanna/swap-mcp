import { afterEach, describe, expect, test, vi } from "vitest";
import { log, redact } from "../../src/log";
import { toErrorEnvelope } from "../../src/errors";

describe("log redaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("redact scrubs secret-name keys", () => {
    const out = redact({
      privateKey: "0xabc...",
      passphrase: "p",
      apiKey: "k",
      authorization: "Bearer x",
      rpcUrl: "https://r",
    });
    expect(out).toEqual({
      privateKey: "[redacted]",
      passphrase: "[redacted]",
      apiKey: "[redacted]",
      authorization: "[redacted]",
      rpcUrl: "[redacted]",
    });
  });

  test("redact truncates long hex runs", () => {
    const longHex = "0x" + "ab".repeat(40); // 82 chars
    const out = redact({ note: longHex }) as { note: string };
    expect(out.note).not.toContain(longHex);

    const address = "0x" + "a".repeat(40); // 42 chars, legitimate
    const survived = redact({ to: address }) as { to: string };
    expect(survived.to).toBe(address);
  });

  test("log emits structured JSON through redact unconditionally", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("info", { privateKey: "x" });
    expect(spy).toHaveBeenCalledTimes(1);
    const serialized = spy.mock.calls[0].join(" ");
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain('"x"');
  });

  test("toErrorEnvelope runs the same redaction pass", () => {
    const longHex = "ab".repeat(40);
    const envelope = toErrorEnvelope("internal", "leak 0x" + longHex);
    expect(envelope.structuredContent.error.message).not.toContain(longHex);
  });
});
