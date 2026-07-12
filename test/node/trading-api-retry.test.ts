import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppError } from "../../src/errors";
import { createTradingApiClient } from "../../src/engine/tradingApiClient";
import { FIXTURE_SWAPPER, quoteClassic } from "../fixtures/tradingApi";

const BASE_URL = "https://trade-api.gateway.uniswap.org/v1";
const API_KEY = "test-api-key";

const QUOTE_INPUT = {
  direction: "ETH_TO_USDC" as const,
  amount: "1000000000000000000",
  swapper: FIXTURE_SWAPPER,
  slippageTolerancePct: 0.5,
};

/** Build a fetch stub returning queued HTTP statuses/bodies; records call count. */
function stubFetch(replies: Array<{ status: number; body?: unknown }>) {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    const reply = replies[i++] ?? replies[replies.length - 1];
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body ?? { detail: "upstream error" },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("TradingApiClient timeout + retry policy", () => {
  test("quote and check_approval retry at most twice on 429/5xx with 250ms then 500ms jittered backoff", async () => {
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    // random = 0.5 → delay = base + 0.5*base = base * 1.5
    const random = () => 0.5;

    // 500, 500, 200 → success on the third attempt (3 fetch calls total).
    const { fetchImpl, calls } = stubFetch([
      { status: 500 },
      { status: 500 },
      { status: 200, body: quoteClassic },
    ]);
    const client = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl,
      sleep,
      random,
    });

    const result = await client.getQuote(QUOTE_INPUT);
    expect(result.routing).toBe("CLASSIC");
    expect(calls).toHaveLength(3);
    // Pinned jitter: delay = base + random()*base; random()=0.5 → base*1.5.
    expect(sleeps).toEqual([250 * 1.5, 500 * 1.5]);

    // check_approval retries identically.
    sleeps.length = 0;
    const approval = stubFetch([
      { status: 429 },
      { status: 503 },
      { status: 200, body: { approval: null } },
    ]);
    const approvalClient = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl: approval.fetchImpl,
      sleep,
      random,
    });
    const approvalResult = await approvalClient.checkApproval({
      token: "0x0000000000000000000000000000000000000000",
      amount: "1000000",
      walletAddress: FIXTURE_SWAPPER,
    });
    expect(approvalResult).toEqual({ approval: null });
    expect(approval.calls).toHaveLength(3);
    expect(sleeps).toEqual([250 * 1.5, 500 * 1.5]);
  });

  test("a jitter of 0 uses the exact base delay (jitter formula pinned to [base, 2*base))", async () => {
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const { fetchImpl } = stubFetch([
      { status: 500 },
      { status: 500 },
      { status: 200, body: quoteClassic },
    ]);
    const client = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl,
      sleep,
      random: () => 0,
    });
    await client.getQuote(QUOTE_INPUT);
    expect(sleeps).toEqual([250, 500]);
  });

  test("after 3 failures (initial + 2 retries) /quote throws upstream_unavailable", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = stubFetch([
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    const client = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
    });
    await expect(client.getQuote(QUOTE_INPUT)).rejects.toThrow(
      new AppError("upstream_unavailable"),
    );
    // initial + 2 retries = 3 attempts, 2 backoff sleeps.
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([250 * 1.5, 500 * 1.5]);
  });

  test("swap is never retried", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = stubFetch([{ status: 500 }, { status: 500 }]);
    const client = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
    });
    await expect(client.buildSwap(quoteClassic as never)).rejects.toThrow(
      new AppError("upstream_unavailable"),
    );
    // Exactly one fetch call — no retry, no double-submission.
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test("4xx other than 429 does not retry", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = stubFetch([
      { status: 400 },
      { status: 200, body: quoteClassic },
    ]);
    const client = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
    });
    await expect(client.getQuote(QUOTE_INPUT)).rejects.toThrow(
      new AppError("upstream_unavailable"),
    );
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  describe("8s per-call timeout (fake timers)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    test("a call exceeding 8s maps to upstream_unavailable", async () => {
      // fetch never resolves; the setTimeout-driven 8s bound must fire.
      const fetchImpl = (() =>
        new Promise<Response>(() => {})) as unknown as typeof fetch;
      const client = createTradingApiClient({
        baseUrl: BASE_URL,
        getApiKey: () => API_KEY,
        fetchImpl,
      });

      const promise = client.getQuote(QUOTE_INPUT);
      const assertion = expect(promise).rejects.toThrow(
        new AppError("upstream_unavailable"),
      );
      await vi.advanceTimersByTimeAsync(8000);
      await assertion;
    });

    test("the in-flight fetch is aborted when the 8s timeout fires", async () => {
      // Capture the AbortSignal the client passes to fetch; the request hangs
      // forever unless aborted, proving the timeout actually cancels it.
      let captured: AbortSignal | undefined;
      const fetchImpl = ((_url: string, init: RequestInit) => {
        captured = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      }) as unknown as typeof fetch;
      const client = createTradingApiClient({
        baseUrl: BASE_URL,
        getApiKey: () => API_KEY,
        fetchImpl,
      });

      const promise = client.getQuote(QUOTE_INPUT);
      const assertion = expect(promise).rejects.toThrow(
        new AppError("upstream_unavailable"),
      );
      expect(captured).toBeInstanceOf(AbortSignal);
      expect(captured?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(8000);
      // The abandoned request is cancelled — no in-flight /swap can still land.
      expect(captured?.aborted).toBe(true);
      await assertion;
    });

    test("a completed call leaves no armed timeout timer", async () => {
      // The 8s timer must be cleared on the winning (fetch-resolves) path too,
      // so a hot swap path does not accumulate 8s timers delaying teardown.
      const fetchImpl = (async () => ({
        ok: true,
        status: 200,
        json: async () => quoteClassic,
      })) as unknown as typeof fetch;
      const client = createTradingApiClient({
        baseUrl: BASE_URL,
        getApiKey: () => API_KEY,
        fetchImpl,
      });

      await client.getQuote(QUOTE_INPUT);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
