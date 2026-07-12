import { describe, expect, test } from "vitest";
import { AppError } from "../../src/errors";
import {
  NATIVE_ETH_SENTINEL,
  UNIVERSAL_ROUTER_ADDRESS,
  USDC_ADDRESS,
} from "../../src/engine/constants";
import {
  createTradingApiClient,
  readQuotedOutput,
  type ClassicQuoteResponse,
} from "../../src/engine/tradingApiClient";
import {
  FIXTURE_SWAPPER,
  quoteClassic,
  quoteDutchV2,
  quoteUnwrap,
  quoteWrap,
  swapMissingKey,
  swapNested,
} from "../fixtures/tradingApi";

const BASE_URL = "https://trade-api.gateway.uniswap.org/v1";
const API_KEY = "test-api-key";

/** A non-2xx reply variant for the fetch stub. */
type ErrorStatusReply = { kind: "status"; status: number };
/** A reply whose body throws on `.json()`, simulating a non-JSON payload. */
type ThrowJsonReply = { kind: "throwJson" };
/** A non-2xx reply of the given HTTP status. */
function status(code: number): ErrorStatusReply {
  return { kind: "status", status: code };
}

/** A 2xx reply whose `.json()` throws (malformed body). */
const throwJson: ThrowJsonReply = { kind: "throwJson" };

/** Type guard for the explicit failure-reply variants. */
function isControlReply(r: unknown): r is ErrorStatusReply | ThrowJsonReply {
  return (
    !!r &&
    typeof r === "object" &&
    "kind" in r &&
    ((r as { kind: unknown }).kind === "status" ||
      (r as { kind: unknown }).kind === "throwJson")
  );
}

/** Build a fetch stub that records every call and replies with the queued replies. */
function stubFetch(replies: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies[i++];
    if (isControlReply(reply)) {
      if (reply.kind === "status") {
        return {
          ok: false,
          status: reply.status,
          json: async () => ({ detail: "upstream error" }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => reply,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function parseBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body));
}

describe("TradingApiClient shapes", () => {
  test("getQuote sends the EXACT_INPUT CLASSIC request contract with pinned tokenIn/tokenOut", async () => {
    const { fetchImpl, calls } = stubFetch([quoteClassic]);
    const client = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl,
    });

    await client.getQuote({
      direction: "ETH_TO_USDC",
      amount: "1000000000000000000",
      swapper: FIXTURE_SWAPPER,
      slippageTolerancePct: 0.5,
    });

    const body = parseBody(calls[0].init);
    expect(body.type).toBe("EXACT_INPUT");
    expect(body.tokenInChainId).toBe("1");
    expect(body.tokenOutChainId).toBe("1");
    expect(body.routingPreference).toBe("CLASSIC");
    expect(body.swapper).toBe(FIXTURE_SWAPPER);
    expect(body.amount).toBe("1000000000000000000");
    expect(body.slippageTolerance).toBe(0.5);
    expect(typeof body.slippageTolerance).toBe("number");
    // ETH_TO_USDC: native-ETH sentinel in, USDC out.
    expect(body.tokenIn).toBe(NATIVE_ETH_SENTINEL);
    expect(body.tokenOut).toBe(USDC_ADDRESS);

    // USDC_TO_ETH is the reverse.
    const rev = stubFetch([quoteUnwrap]);
    const revClient = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl: rev.fetchImpl,
    });
    await revClient.getQuote({
      direction: "USDC_TO_ETH",
      amount: "1000000",
      swapper: FIXTURE_SWAPPER,
      slippageTolerancePct: 0.5,
    });
    const revBody = parseBody(rev.calls[0].init);
    expect(revBody.tokenIn).toBe(USDC_ADDRESS);
    expect(revBody.tokenOut).toBe(NATIVE_ETH_SENTINEL);
  });

  test("all calls carry required headers", async () => {
    const { fetchImpl, calls } = stubFetch([
      { approval: null },
      quoteClassic,
      swapNested,
    ]);
    const client = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl,
    });

    await client.checkApproval({
      token: USDC_ADDRESS,
      amount: "1000000",
      walletAddress: FIXTURE_SWAPPER,
    });
    const quote = await client.getQuote({
      direction: "ETH_TO_USDC",
      amount: "1000000000000000000",
      swapper: FIXTURE_SWAPPER,
      slippageTolerancePct: 0.5,
    });
    await client.buildSwap(quote);

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.url.startsWith(BASE_URL)).toBe(true);
      const headers = call.init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe(API_KEY);
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["x-universal-router-version"]).toBe("2.0");
    }
  });

  test("routing-shape assertion fails closed on non-CLASSIC-family routing", async () => {
    const { fetchImpl } = stubFetch([quoteDutchV2]);
    const client = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl,
    });

    await expect(
      client.getQuote({
        direction: "ETH_TO_USDC",
        amount: "1000000000000000000",
        swapper: FIXTURE_SWAPPER,
        slippageTolerancePct: 0.5,
      }),
    ).rejects.toThrow(new AppError("upstream_unavailable"));
  });

  test("quoted output is read via the routing-aware accessor", () => {
    for (const fixture of [quoteClassic, quoteWrap, quoteUnwrap]) {
      const q = fixture as unknown as ClassicQuoteResponse;
      expect(readQuotedOutput(q)).toBe(fixture.quote.output.amount);
    }
  });

  test("buildSwap spreads the quote, strips null permit fields, and unwraps the nested { swap } response", async () => {
    const { fetchImpl, calls } = stubFetch([swapNested]);
    const client = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl,
    });

    const result = await client.buildSwap(
      quoteClassic as unknown as ClassicQuoteResponse,
    );

    const body = parseBody(calls[0].init);
    // Quote response spread at top level, not nested under `quote`.
    expect(body.routing).toBe("CLASSIC");
    expect(body.quote).toEqual(quoteClassic.quote);
    expect((body as Record<string, unknown>).quote).not.toBe(quoteClassic);
    // Null permit fields stripped entirely.
    expect("permitData" in body).toBe(false);
    expect("permitTransaction" in body).toBe(false);

    // Response unwrapped from the nested { swap } envelope.
    expect(result).toEqual({
      to: UNIVERSAL_ROUTER_ADDRESS,
      data: "0xfeed",
      value: "1000000000000000000",
      chainId: 1,
      gasLimit: "250000",
    });
    expect(result.to).toBe(UNIVERSAL_ROUTER_ADDRESS);
  });

  test("non-2xx upstream responses fail closed with upstream_unavailable", async () => {
    for (const code of [400, 429, 500]) {
      const { fetchImpl } = stubFetch([status(code)]);
      const client = createTradingApiClient({
        baseUrl: BASE_URL,
        getApiKey: () => API_KEY,
        fetchImpl,
      });
      await expect(
        client.getQuote({
          direction: "ETH_TO_USDC",
          amount: "1000000000000000000",
          swapper: FIXTURE_SWAPPER,
          slippageTolerancePct: 0.5,
        }),
      ).rejects.toThrow(new AppError("upstream_unavailable"));
    }

    // check_approval is on the same untrusted path.
    const { fetchImpl } = stubFetch([status(503)]);
    const client = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl,
    });
    await expect(
      client.checkApproval({
        token: USDC_ADDRESS,
        amount: "1000000",
        walletAddress: FIXTURE_SWAPPER,
      }),
    ).rejects.toThrow(new AppError("upstream_unavailable"));
  });

  test("a malformed non-JSON body maps to upstream_unavailable, not a raw SyntaxError", async () => {
    const { fetchImpl } = stubFetch([throwJson]);
    const client = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl,
    });
    await expect(
      client.getQuote({
        direction: "ETH_TO_USDC",
        amount: "1000000000000000000",
        swapper: FIXTURE_SWAPPER,
        slippageTolerancePct: 0.5,
      }),
    ).rejects.toThrow(new AppError("upstream_unavailable"));
  });

  test("buildSwap fails closed when the /swap response is missing the swap key", async () => {
    const { fetchImpl } = stubFetch([swapMissingKey]);
    const client = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl,
    });
    await expect(
      client.buildSwap(quoteClassic as unknown as ClassicQuoteResponse),
    ).rejects.toThrow(new AppError("upstream_unavailable"));
  });

  test("native ETH uses the zero-address sentinel", async () => {
    const { fetchImpl, calls } = stubFetch([quoteClassic, quoteUnwrap]);
    const client = createTradingApiClient({
      baseUrl: BASE_URL,
      getApiKey: () => API_KEY,
      fetchImpl,
    });

    await client.getQuote({
      direction: "ETH_TO_USDC",
      amount: "1000000000000000000",
      swapper: FIXTURE_SWAPPER,
      slippageTolerancePct: 0.5,
    });
    await client.getQuote({
      direction: "USDC_TO_ETH",
      amount: "1000000",
      swapper: FIXTURE_SWAPPER,
      slippageTolerancePct: 0.5,
    });

    // ETH_TO_USDC input is the sentinel; USDC_TO_ETH output is the sentinel.
    expect(parseBody(calls[0].init).tokenIn).toBe(NATIVE_ETH_SENTINEL);
    expect(parseBody(calls[1].init).tokenOut).toBe(NATIVE_ETH_SENTINEL);
  });
});
