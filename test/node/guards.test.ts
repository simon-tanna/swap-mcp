import { describe, expect, test } from "vitest";
import { AppError } from "../../src/errors";
import {
  SINGLE_USER_ID,
  assertAudience,
  requireScope,
  transportGuard,
} from "../../src/auth/guards";

const canonicalUri = "https://swap-mcp.example.com/mcp";
const allowedOrigins = ["https://claude.ai"];

function reqWithHeaders(headers: Record<string, string>): Request {
  return new Request("https://example/mcp", { headers });
}

describe("transportGuard", () => {
  test("allows an allowlisted Origin", () => {
    const ok = reqWithHeaders({
      Origin: "https://claude.ai",
      "MCP-Protocol-Version": "2025-06-18",
    });
    expect(() => transportGuard(ok, allowedOrigins)).not.toThrow();
  });

  test("rejects a present-but-disallowed Origin", () => {
    const disallowedOrigin = reqWithHeaders({
      Origin: "https://evil.example",
      "MCP-Protocol-Version": "2025-06-18",
    });
    try {
      transportGuard(disallowedOrigin, allowedOrigins);
      throw new Error("expected transportGuard to throw");
    } catch (err) {
      expect(err instanceof AppError && err.code === "forbidden").toBe(true);
    }
  });

  test("allows a request with NO Origin header (server-side MCP client)", () => {
    // Real remote connectors (Claude/GPT/Grok) send no Origin — the bearer token
    // authenticates them. Origin is a browser-only DNS-rebinding signal, so its
    // absence must NOT be rejected. Also: no MCP-Protocol-Version required.
    const noOrigin = reqWithHeaders({});
    expect(() => transportGuard(noOrigin, allowedOrigins)).not.toThrow();
  });

  test("does not require an MCP-Protocol-Version header", () => {
    // Per the MCP spec the server defaults the version when the header is absent;
    // the transport negotiates it. The guard must not gate on the header.
    const missingVersion = reqWithHeaders({ Origin: "https://claude.ai" });
    expect(() => transportGuard(missingVersion, allowedOrigins)).not.toThrow();
  });

  test("rejects an empty allowedOrigins allowlist even for a plausible origin", () => {
    const req = reqWithHeaders({
      Origin: "https://claude.ai",
      "MCP-Protocol-Version": "2025-06-18",
    });
    try {
      transportGuard(req, []);
      throw new Error("expected transportGuard to throw");
    } catch (err) {
      expect(err instanceof AppError && err.code === "forbidden").toBe(true);
    }
  });

  test("rejects Origin values that differ from the allowlist only by trailing slash or case", () => {
    const trailingSlash = reqWithHeaders({
      Origin: "https://claude.ai/",
      "MCP-Protocol-Version": "2025-06-18",
    });
    try {
      transportGuard(trailingSlash, allowedOrigins);
      throw new Error("expected transportGuard to throw");
    } catch (err) {
      expect(err instanceof AppError && err.code === "forbidden").toBe(true);
    }

    const differentCase = reqWithHeaders({
      Origin: "https://Claude.AI",
      "MCP-Protocol-Version": "2025-06-18",
    });
    try {
      transportGuard(differentCase, allowedOrigins);
      throw new Error("expected transportGuard to throw");
    } catch (err) {
      expect(err instanceof AppError && err.code === "forbidden").toBe(true);
    }
  });
});

describe("assertAudience", () => {
  test("fails closed on foreign resource", () => {
    try {
      assertAudience({ resource: "https://other/mcp" }, canonicalUri);
      throw new Error("expected assertAudience to throw");
    } catch (err) {
      expect(err instanceof AppError && err.code === "forbidden").toBe(true);
    }

    expect(() =>
      assertAudience({ resource: canonicalUri }, canonicalUri),
    ).not.toThrow();
  });

  test("fails closed on a trailing-slash resource (no normalization)", () => {
    try {
      assertAudience({ resource: canonicalUri + "/" }, canonicalUri);
      throw new Error("expected assertAudience to throw");
    } catch (err) {
      expect(err instanceof AppError && err.code === "forbidden").toBe(true);
    }
  });

  test("fails closed on an empty resource (no normalization)", () => {
    try {
      assertAudience({ resource: "" }, canonicalUri);
      throw new Error("expected assertAudience to throw");
    } catch (err) {
      expect(err instanceof AppError && err.code === "forbidden").toBe(true);
    }
  });
});

describe("requireScope", () => {
  test("gates read and write", () => {
    try {
      requireScope({ scopes: ["swap:read"] }, "swap:write");
      throw new Error("expected requireScope to throw");
    } catch (err) {
      expect(err instanceof AppError && err.code === "forbidden").toBe(true);
    }

    expect(() =>
      requireScope({ scopes: ["swap:read", "swap:write"] }, "swap:write"),
    ).not.toThrow();

    const noScopes = { scopes: undefined } as unknown as {
      scopes: string[];
    };
    try {
      requireScope(noScopes, "swap:read");
      throw new Error("expected requireScope to throw");
    } catch (err) {
      expect(err instanceof AppError && err.code === "forbidden").toBe(true);
    }
  });

  test("fails closed on an empty scopes array", () => {
    try {
      requireScope({ scopes: [] }, "swap:read");
      throw new Error("expected requireScope to throw");
    } catch (err) {
      expect(err instanceof AppError && err.code === "forbidden").toBe(true);
    }
  });
});

describe("SINGLE_USER_ID", () => {
  test("is a stable constant", () => {
    expect(typeof SINGLE_USER_ID).toBe("string");
    expect(SINGLE_USER_ID.length).toBeGreaterThan(0);
  });
});
