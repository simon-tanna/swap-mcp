import { Hono } from "hono";
import { describe, expect, test } from "vitest";

import type { AuthProps } from "../../src/auth/guards";
import {
  AppError,
  CURATED_MESSAGE,
  ERROR_CODES,
  type ErrorCode,
} from "../../src/errors";
import {
  propsAdapter,
  errorCodeToHttpStatus,
  errorResponse,
} from "../../src/api/middleware/props";

const EXPECTED_STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  slippage_exceeded: 409,
  insufficient_balance: 409,
  approval_required: 409,
  upstream_unavailable: 502,
  rate_limited: 429,
  swap_failed: 502,
  internal: 500,
};

function fakeProps(): AuthProps {
  return {
    userId: "single-user",
    scopes: ["swap:read", "swap:write"],
    resource: "https://swap.example/mcp",
  };
}

function buildApp() {
  const app = new Hono<{ Variables: { props: AuthProps } }>();
  app.use("*", propsAdapter);
  app.get("/whoami", (c) => {
    // Route reads identity via c.get("props") only — never touches executionCtx.
    return c.json({ props: c.get("props") });
  });
  return app;
}

describe("propsAdapter", () => {
  test('middleware threads executionCtx.props into c.get("props")', async () => {
    const app = buildApp();
    const props = fakeProps();
    const executionCtx = {
      props,
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const res = await app.request("/whoami", {}, {}, executionCtx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { props: AuthProps };
    expect(body.props).toEqual(props);
  });

  test("missing props yields 401 unauthorized envelope", async () => {
    const app = buildApp();

    // No executionCtx at all — accessing c.executionCtx throws in Hono; the
    // middleware must guard against that and still respond 401.
    const res = await app.request("/whoami");

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: "unauthorized", message: CURATED_MESSAGE.unauthorized },
    });
  });

  test("errorCodeToHttpStatus maps every allowlisted code", () => {
    expect(ERROR_CODES.length).toBe(Object.keys(EXPECTED_STATUS).length);
    for (const code of ERROR_CODES) {
      expect(errorCodeToHttpStatus(code)).toBe(EXPECTED_STATUS[code]);
    }
  });

  test("errorResponse maps an AppError to its status and curated body", async () => {
    const app = new Hono();
    app.get("/boom", (c) =>
      errorResponse(c, new AppError("slippage_exceeded")),
    );

    const res = await app.request("/boom");

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "slippage_exceeded",
        message: CURATED_MESSAGE.slippage_exceeded,
      },
    });
  });

  test("errorResponse never leaks a raw non-AppError through the REST seam", async () => {
    const leak =
      "secret rpc https://evil/path 0xdeadbeefdeadbeefdeadbeefdeadbeef";
    const app = new Hono();
    app.get("/boom", (c) => errorResponse(c, new Error(leak)));

    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain("0xdeadbeef");
    expect(raw).not.toContain("evil");
    expect(raw).not.toContain("secret");
    expect(JSON.parse(raw)).toEqual({
      error: { code: "internal", message: CURATED_MESSAGE.internal },
    });
  });
});
