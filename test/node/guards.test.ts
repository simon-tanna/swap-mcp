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
  test("enforces Origin allowlist and MCP-Protocol-Version", () => {
    const ok = reqWithHeaders({
      Origin: "https://claude.ai",
      "MCP-Protocol-Version": "2025-06-18",
    });
    expect(() => transportGuard(ok, allowedOrigins)).not.toThrow();

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

    const missingVersion = reqWithHeaders({ Origin: "https://claude.ai" });
    try {
      transportGuard(missingVersion, allowedOrigins);
      throw new Error("expected transportGuard to throw");
    } catch (err) {
      expect(err instanceof AppError && err.code === "invalid_input").toBe(
        true,
      );
    }
  });

  test("rejects an empty-string MCP-Protocol-Version header", () => {
    const emptyVersion = reqWithHeaders({
      Origin: "https://claude.ai",
      "MCP-Protocol-Version": "",
    });
    expect(() => transportGuard(emptyVersion, allowedOrigins)).toThrow(
      AppError,
    );
    try {
      transportGuard(emptyVersion, allowedOrigins);
      throw new Error("expected transportGuard to throw");
    } catch (err) {
      expect(err instanceof AppError && err.code === "invalid_input").toBe(
        true,
      );
    }
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
