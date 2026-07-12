import type { Context, MiddlewareHandler } from "hono";

import type { AuthProps } from "../../auth/guards";
import { classify, CURATED_MESSAGE, type ErrorCode } from "../../errors";

/**
 * The REST error body: a plain `{ error: { code, message } }` JSON shape.
 * Distinct from the MCP tool envelope (`ErrorEnvelope`) which additionally
 * carries `content`/`structuredContent`/`isError` for the MCP protocol.
 */
export type RestErrorBody = { error: { code: ErrorCode; message: string } };

/** Build the REST error body for an allowlisted code using the shared curated message. */
function toRestErrorBody(code: ErrorCode): RestErrorBody {
  return { error: { code, message: CURATED_MESSAGE[code] } };
}

/**
 * Total map from every allowlisted {@link ErrorCode} to its HTTP status.
 * Typed as `Record<ErrorCode, number>` so omitting a code is a compile error (G10).
 */
const ERROR_CODE_TO_HTTP_STATUS: Record<ErrorCode, number> = {
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

/** Map an allowlisted error code to its HTTP status. Total over {@link ErrorCode}. */
export function errorCodeToHttpStatus(code: ErrorCode): number {
  return ERROR_CODE_TO_HTTP_STATUS[code];
}

/** Classify a thrown value and respond with the mapped HTTP status and REST error body. */
export function errorResponse(c: Context, err: unknown): Response {
  const code = classify(err);
  return c.json(toRestErrorBody(code), errorCodeToHttpStatus(code) as 200);
}

/**
 * The single REST identity thread-point (M9): Cloudflare Workers-OAuth-provider
 * places the authenticated identity on `c.executionCtx.props`. This middleware
 * copies it to `c.set("props", props)` so every downstream REST route reads
 * identity from exactly one place — `c.get("props")` — and never touches
 * `executionCtx` directly.
 *
 * `c.executionCtx` throws when no ExecutionContext was supplied to the
 * request (e.g. in tests that omit it), so that case is treated the same as
 * "no props": respond 401 without calling `next()`.
 */
export const propsAdapter: MiddlewareHandler<{
  Variables: { props: AuthProps };
}> = async (c, next) => {
  let props: AuthProps | undefined;
  try {
    props = (c.executionCtx as ExecutionContext & { props?: AuthProps }).props;
  } catch {
    props = undefined;
  }

  if (!props) {
    return c.json(
      toRestErrorBody("unauthorized"),
      errorCodeToHttpStatus("unauthorized") as 401,
    );
  }

  c.set("props", props);
  await next();
};
