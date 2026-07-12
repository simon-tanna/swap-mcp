/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, test, vi } from "vitest";
import { timingSafeEqualDigest } from "../../src/auth/constantTime";

describe("timingSafeEqualDigest", () => {
  test("equal strings compare true", async () => {
    await expect(timingSafeEqualDigest("secret", "secret")).resolves.toBe(true);
  });

  test("unequal strings compare false", async () => {
    await expect(timingSafeEqualDigest("secret", "secreT")).resolves.toBe(
      false,
    );
  });

  test("length difference compares false without throwing", async () => {
    await expect(timingSafeEqualDigest("secret", "sec")).resolves.toBe(false);
  });

  test("comparison operates on SHA-256 digests", async () => {
    const digest = vi.fn((data: Uint8Array) =>
      crypto.subtle.digest("SHA-256", data),
    );
    await timingSafeEqualDigest("secret", "secret", { digest });
    expect(digest).toHaveBeenCalledTimes(2);
  });
});
