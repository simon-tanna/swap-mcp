import { afterEach, describe, expect, test, vi } from "vitest";
import {
  log,
  normalizeErrorDetail,
  redact,
  safeError,
  scrubUrl,
} from "../../src/log";
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

describe("scrubUrl", () => {
  test("redacts an http(s) URL greedily to the whitespace boundary (query included)", () => {
    const keyed = "https://mainnet.infura.io/v3/SECRETKEY123?x=1";
    const out = scrubUrl(`connect failed URL: ${keyed} after 3 tries`);
    expect(out).not.toContain("infura.io");
    expect(out).not.toContain("SECRETKEY123");
    expect(out).not.toContain("x=1");
    // Non-secret surrounding text survives.
    expect(out).toContain("connect failed");
    expect(out).toContain("after 3 tries");
  });

  test("redacts a wss URL", () => {
    const out = scrubUrl("socket wss://relay.example/v3/KEY dropped");
    expect(out).not.toContain("relay.example");
    expect(out).not.toContain("KEY");
  });
});

describe("normalizeErrorDetail — @noble private-key leak shapes", () => {
  test("collapses the non-hex-character shape (drops the raw key chars + index)", () => {
    const msg =
      'private key must be hex string or Uint8Array, cause: Error: hex string expected, got non-hex character "9z" at index 3';
    const out = normalizeErrorDetail(msg);
    expect(out).not.toContain('"9z"');
    expect(out).not.toContain("at index");
    expect(out).toContain("malformed private key");
  });

  test("collapses the scalar-range shape (drops the FULL decoded key bigint)", () => {
    // An in-format-but-out-of-range key (e.g. all-`f`s) makes @noble decode and
    // embed the full private key as a decimal bigint — not 0x-hex, so scrubHex
    // misses it. normalizeErrorDetail must strip the `got <n>` trailer.
    const fullKeyDecimal =
      "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    const msg = `expected valid private key: 1 <= n < 115792089237316195423570985008687907852837564279074904382605163141518161494337, got ${fullKeyDecimal}`;
    const out = normalizeErrorDetail(msg);
    expect(out).not.toContain(fullKeyDecimal);
    expect(out).not.toContain("got ");
    expect(out).toContain("malformed private key");
  });

  test("hard-caps length", () => {
    const out = normalizeErrorDetail("x".repeat(5000));
    expect(out.length).toBeLessThanOrEqual(512);
  });
});

describe("safeError", () => {
  test("uses constructor.name (plain @noble Error → 'Error') and a normalized, scrubbed detail", () => {
    const err = new Error(
      'hex string expected, got non-hex character "9z" at index 3',
    );
    const { errorName, detail } = safeError(err);
    expect(errorName).toBe("Error");
    expect(detail).not.toContain('"9z"');
  });

  test("surfaces a viem-style subclass name via constructor.name", () => {
    class HttpRequestError extends Error {}
    const { errorName } = safeError(new HttpRequestError("boom"));
    expect(errorName).toBe("HttpRequestError");
  });

  test("leaks neither a keyed RPC URL nor a bare 0x key through a viem-style message", () => {
    const key = "0x" + "ab".repeat(40);
    const err = new Error(
      `HTTP request failed. URL: https://mainnet.infura.io/v3/SECRETKEY?x=1 Body: {"key":"${key}"}`,
    );
    const { detail } = safeError(err);
    expect(detail).not.toContain("infura.io");
    expect(detail).not.toContain("SECRETKEY");
    expect(detail).not.toContain(key);
  });

  test("non-Error input is stringified through the scrub stage (URL + 0x key redacted)", () => {
    const key = "0x" + "cd".repeat(40);
    const raw = `raw throw https://rpc.example/v3/LEAK ${key}`;
    const { errorName, detail } = safeError(raw);
    expect(errorName).toBe("string");
    expect(detail).not.toContain("rpc.example");
    expect(detail).not.toContain("LEAK");
    expect(detail).not.toContain(key);
  });
});
