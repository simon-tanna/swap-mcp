/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type { RateLimiter } from "../../src/ratelimit/RateLimiter";

/** Base instant (ms) used to pin the injected clock at a fixed window start. */
const T0 = 1_700_000_000_000;

/** Pin the DO's injectable clock to a fixed millisecond instant. */
async function setClock(
  stub: DurableObjectStub<RateLimiter>,
  ms: number,
): Promise<void> {
  await runInDurableObject(stub, (instance: RateLimiter) => {
    instance.now = () => ms;
  });
}

describe("RateLimiter", () => {
  test("per-IP budget denies the 6th failure within 10 minutes", async () => {
    const id = env.RATE_LIMITER.idFromName("per-ip-budget");
    const stub = env.RATE_LIMITER.get(id);
    await setClock(stub, T0);

    for (let i = 0; i < 5; i++) {
      expect(await stub.checkAndConsume("1.2.3.4")).toEqual({ allowed: true });
    }
    expect(await stub.checkAndConsume("1.2.3.4")).toEqual({
      allowed: false,
      reason: "per_ip",
    });
  });

  test("global budget denies the 21st failure across IPs", async () => {
    const id = env.RATE_LIMITER.idFromName("global-budget");
    const stub = env.RATE_LIMITER.get(id);
    await setClock(stub, T0);

    // 20 failures across 20 distinct IPs (4 per IP keeps each under the per-IP
    // ceiling of 5, so only the global budget can be the denier).
    for (let ip = 0; ip < 20; ip++) {
      const result = await stub.checkAndConsume(`10.0.0.${ip}`);
      expect(result).toEqual({ allowed: true });
    }
    // A fresh 21st IP is denied purely on the global budget.
    expect(await stub.checkAndConsume("10.0.1.99")).toEqual({
      allowed: false,
      reason: "global",
    });
  });

  test("windows are fixed 10-minute tumbling windows expiring lazily", async () => {
    const id = env.RATE_LIMITER.idFromName("window-expiry");
    const stub = env.RATE_LIMITER.get(id);
    await setClock(stub, T0);

    for (let i = 0; i < 5; i++) {
      expect(await stub.checkAndConsume("5.5.5.5")).toEqual({ allowed: true });
    }
    expect(await stub.checkAndConsume("5.5.5.5")).toEqual({
      allowed: false,
      reason: "per_ip",
    });

    // Advance past windowStart + 600s: the window is expired and the counter
    // resets lazily on the next read, so the previously-denied IP is allowed.
    await setClock(stub, T0 + 600_000);
    expect(await stub.checkAndConsume("5.5.5.5")).toEqual({ allowed: true });
  });

  test("recordSuccess resets the per-IP window but not the global budget", async () => {
    const id = env.RATE_LIMITER.idFromName("record-success");
    const stub = env.RATE_LIMITER.get(id);
    await setClock(stub, T0);

    for (let i = 0; i < 4; i++) {
      expect(await stub.checkAndConsume("7.7.7.7")).toEqual({ allowed: true });
    }
    await stub.recordSuccess("7.7.7.7");

    // Per-IP window reset: 5 more failures fit under the per-IP ceiling.
    for (let i = 0; i < 5; i++) {
      expect(await stub.checkAndConsume("7.7.7.7")).toEqual({ allowed: true });
    }

    // Global budget still carries the original 4: after those 4 plus 5 more = 9
    // global failures on one IP (per-IP now at 5), 11 fresh IPs bring the global
    // count to 20; the 12th fresh IP is denied globally, proving recordSuccess
    // did NOT rewind the global budget.
    for (let ip = 0; ip < 11; ip++) {
      expect(await stub.checkAndConsume(`8.0.0.${ip}`)).toEqual({
        allowed: true,
      });
    }
    expect(await stub.checkAndConsume("8.0.1.99")).toEqual({
      allowed: false,
      reason: "global",
    });
  });

  test("ceiling holds under concurrent checkAndConsume calls", async () => {
    const id = env.RATE_LIMITER.idFromName("concurrent");
    const stub = env.RATE_LIMITER.get(id);
    await setClock(stub, T0);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => stub.checkAndConsume("9.9.9.9")),
    );
    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;
    expect(allowed).toBe(5);
    expect(denied).toBe(5);
  });

  test("reservations are fail-safe-closed", async () => {
    const id = env.RATE_LIMITER.idFromName("fail-safe-closed");
    const stub = env.RATE_LIMITER.get(id);
    await setClock(stub, T0);

    // Consume 5 reservations and report NO outcome for any of them. The
    // reservation itself consumed budget at check time, so the 6th is denied.
    for (let i = 0; i < 5; i++) {
      expect(await stub.checkAndConsume("3.3.3.3")).toEqual({ allowed: true });
    }
    expect(await stub.checkAndConsume("3.3.3.3")).toEqual({
      allowed: false,
      reason: "per_ip",
    });
  });
});
