import { describe, expect, test } from "vitest";
import { classify } from "../../src/errors";
import { validateEnv } from "../../src/env";

const SWAP_PRIVATE_KEY = "0xswapprivatekeysecret";
const AUTH_PASSPHRASE = "auth-passphrase-secret";
const UNISWAP_API_KEY = "uniswap-api-key-secret";
const ETH_RPC_URL = "https://rpc.example/secret-path";

/**
 * A complete, valid fake env carrying every var/secret `validateEnv` reads.
 * The cast supplies the two resource bindings (`OAUTH_KV`, `DB`) that
 * `CloudflareBindings` requires but `validateEnv` never touches.
 */
function completeEnv(): CloudflareBindings {
  return {
    SWAP_PRIVATE_KEY,
    AUTH_PASSPHRASE,
    UNISWAP_API_KEY,
    ETH_RPC_URL,
    CHAIN_ID: "1",
    CANONICAL_MCP_URI: "https://swap-mcp.example.workers.dev/mcp",
    TRADING_API_BASE_URL: "https://trade-api.gateway.uniswap.org/v1",
    ALLOWED_ORIGINS: "https://claude.ai,https://swap-mcp.example.workers.dev",
  } as unknown as CloudflareBindings;
}

describe("env", () => {
  test("validateEnv fails closed on any missing secret or var", () => {
    expect(() => validateEnv(completeEnv())).not.toThrow();

    const required = [
      "SWAP_PRIVATE_KEY",
      "AUTH_PASSPHRASE",
      "UNISWAP_API_KEY",
      "ETH_RPC_URL",
      "CHAIN_ID",
      "CANONICAL_MCP_URI",
      "TRADING_API_BASE_URL",
      "ALLOWED_ORIGINS",
    ] as const;

    for (const key of required) {
      const env = completeEnv() as unknown as Record<string, unknown>;
      delete env[key];
      let thrown: unknown;
      try {
        validateEnv(env as unknown as CloudflareBindings);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `removing ${key} must throw`).toBeDefined();
      expect(classify(thrown), `${key} error classified internal`).toBe(
        "internal",
      );
    }
  });

  test('CHAIN_ID must be "1"', () => {
    const env = completeEnv() as unknown as Record<string, unknown>;
    env.CHAIN_ID = "5";
    expect(() => validateEnv(env as unknown as CloudflareBindings)).toThrow();
    expect(() => validateEnv(completeEnv())).not.toThrow();
  });

  test("TRADING_API_BASE_URL host allowlist", () => {
    const evil = completeEnv() as unknown as Record<string, unknown>;
    evil.TRADING_API_BASE_URL = "https://evil.example/v1";
    expect(() => validateEnv(evil as unknown as CloudflareBindings)).toThrow();

    const good = completeEnv() as unknown as Record<string, unknown>;
    good.TRADING_API_BASE_URL = "https://trade-api.gateway.uniswap.org/v1";
    const validated = validateEnv(good as unknown as CloudflareBindings);
    expect(validated.tradingApiBaseUrl).toBe(
      "https://trade-api.gateway.uniswap.org/v1",
    );
  });

  test("TRADING_API_BASE_URL must be https (no http bypass)", () => {
    const plaintext = completeEnv() as unknown as Record<string, unknown>;
    plaintext.TRADING_API_BASE_URL = "http://trade-api.gateway.uniswap.org/v1";
    expect(() =>
      validateEnv(plaintext as unknown as CloudflareBindings),
    ).toThrow();

    const secure = completeEnv() as unknown as Record<string, unknown>;
    secure.TRADING_API_BASE_URL = "https://trade-api.gateway.uniswap.org/v1";
    expect(() =>
      validateEnv(secure as unknown as CloudflareBindings),
    ).not.toThrow();
  });

  test("TRADING_API_BASE_URL trailing-dot host fails closed", () => {
    const trailingDot = completeEnv() as unknown as Record<string, unknown>;
    trailingDot.TRADING_API_BASE_URL =
      "https://trade-api.gateway.uniswap.org./v1";
    expect(() =>
      validateEnv(trailingDot as unknown as CloudflareBindings),
    ).toThrow();
  });

  test("ALLOWED_ORIGINS filters out empty entries", () => {
    const env = completeEnv() as unknown as Record<string, unknown>;
    env.ALLOWED_ORIGINS = "https://claude.ai, , https://x.com,";
    const validated = validateEnv(env as unknown as CloudflareBindings);
    expect(validated.allowedOrigins).toEqual([
      "https://claude.ai",
      "https://x.com",
    ]);
  });

  test("secrets are accessor functions, never plain fields", () => {
    const validated = validateEnv(completeEnv());

    const serialized = JSON.stringify(validated);
    for (const secret of [
      SWAP_PRIVATE_KEY,
      AUTH_PASSPHRASE,
      UNISWAP_API_KEY,
      ETH_RPC_URL,
    ]) {
      expect(serialized).not.toContain(secret);
    }

    const values = Object.values(validated);
    for (const secret of [
      SWAP_PRIVATE_KEY,
      AUTH_PASSPHRASE,
      UNISWAP_API_KEY,
      ETH_RPC_URL,
    ]) {
      expect(values).not.toContain(secret);
    }

    expect(validated.getSwapPrivateKey()).toBe(SWAP_PRIVATE_KEY);
    expect(validated.getAuthPassphrase()).toBe(AUTH_PASSPHRASE);
    expect(validated.getUniswapApiKey()).toBe(UNISWAP_API_KEY);
    expect(validated.getEthRpcUrl()).toBe(ETH_RPC_URL);

    expect(validated.allowedOrigins).toEqual([
      "https://claude.ai",
      "https://swap-mcp.example.workers.dev",
    ]);
    expect(validated.chainId).toBe("1");
  });
});
