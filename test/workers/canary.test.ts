/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

describe("canary", () => {
  test("workers pool boots with wrangler config and exposes bindings", async () => {
    expect(env.OAUTH_KV).toBeDefined();
    expect(env.DB).toBeDefined();
    await expect(env.DB.prepare("SELECT 1").first()).resolves.toBeDefined();
    expect(env.CHAIN_ID).toBe("1");
    expect(env.CANONICAL_MCP_URI).toBeDefined();
    expect(env.TRADING_API_BASE_URL).toBeDefined();
    expect(env.ALLOWED_ORIGINS).toBeDefined();
  });
});
