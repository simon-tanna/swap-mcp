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

  test("redact scrubs secrets nested inside arrays", () => {
    const out = redact({ list: [{ apiKey: "k" }] }) as {
      list: [{ apiKey: string }];
    };
    expect(out.list[0].apiKey).toBe("[redacted]");
  });

  test("redact scrubs long hex strings inside arrays", () => {
    const longHex = "0x" + "ab".repeat(40);
    const out = redact({ hexes: [longHex] }) as { hexes: string[] };
    expect(out.hexes[0]).not.toContain(longHex);
  });

  test("log does not throw on BigInt fields and never emits the raw secret", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() =>
      log("info", { amount: 10n, apiKey: "topsecret" }),
    ).not.toThrow();
    const serialized = spy.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(serialized).not.toContain("topsecret");
  });

  test("log does not throw on circular references and never emits the raw secret", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const circular: Record<string, unknown> = { apiKey: "topsecret" };
    circular.self = circular;
    expect(() => log("info", circular)).not.toThrow();
    const serialized = spy.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(serialized).not.toContain("topsecret");
  });

  test("redact preserves shared (diamond) references and still catches real cycles", () => {
    const shared = { apiKey: "k" };
    const out = redact({ a: shared, b: shared }) as {
      a: { apiKey: string };
      b: { apiKey: string };
    };
    expect(out.a.apiKey).toBe("[redacted]");
    expect(out.b.apiKey).toBe("[redacted]");
    expect(out.b).not.toBe("[circular]");

    const arrOut = redact({ list: [shared, shared] }) as {
      list: [{ apiKey: string }, { apiKey: string }];
    };
    expect(arrOut.list[0].apiKey).toBe("[redacted]");
    expect(arrOut.list[1].apiKey).toBe("[redacted]");
    expect(arrOut.list[1]).not.toBe("[circular]");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cycOut = redact({ o: cyclic }) as { o: { self: unknown } };
    expect(cycOut.o.self).toBe("[circular]");
  });

  test("toErrorEnvelope runs the same redaction pass", () => {
    const longHex = "ab".repeat(40);
    const envelope = toErrorEnvelope("internal", "leak 0x" + longHex);
    expect(envelope.structuredContent.error.message).not.toContain(longHex);
  });
});
