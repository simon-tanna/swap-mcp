/** Case-insensitive pattern matching key names that carry secret material. */
const SECRET_KEY_PATTERN =
  /(private[_-]?key|passphrase|api[_-]?key|authorization|auth[_-]?token|bearer|secret|password|mnemonic|seed|rpc[_-]?url)/i;

/**
 * Matches `0x`-prefixed hex runs longer than a 42-char (20-byte) address.
 * Only `0x`-prefixed material is scrubbed: bare hex is intentionally out of scope
 * because this helper also feeds user-facing error envelopes where 64-hex transaction
 * hashes must stay readable. The primary secret-leak defenses are the secret-name key
 * match plus this `0x`-prefixed scrub.
 */
const LONG_HEX_PATTERN = /0x[0-9a-fA-F]{41,}/g;

/**
 * Scrub over-length `0x`-prefixed hex runs from a string, leaving 42-char addresses intact.
 * Bare (non-`0x`) hex is deliberately not scrubbed — see LONG_HEX_PATTERN.
 */
export function scrubHex(value: string): string {
  return value.replace(LONG_HEX_PATTERN, "[redacted]");
}

/**
 * Matches an `http(s)`/`ws(s)` URL run up to the next whitespace — deliberately
 * greedy through the path and query string. A keyed RPC URL
 * (`https://host/v3/<API_KEY>?…`) rides verbatim in viem's `HttpRequestError`
 * message, and `ETH_RPC_URL` carries no scheme/host validation, so the whole
 * run (query included) must be consumed, not just the origin.
 */
const URL_PATTERN = /(?:https?|wss?):\/\/\S+/gi;

/**
 * Redact full URLs (scheme through the end of the query string) to `[url]`.
 * Applied ONLY to error-detail strings via {@link safeError}, never globally,
 * so legitimate worker URLs in request/`waitUntil` logs stay readable.
 */
export function scrubUrl(value: string): string {
  return value.replace(URL_PATTERN, "[url]");
}

/** Upper bound on a logged error detail; a runaway message never floods a log line. */
const MAX_DETAIL_LEN = 512;

/**
 * Collapse known secret-bearing error-message shapes to a fixed, material-free
 * classification string BEFORE the generic scrubbers run, then hard-cap length.
 *
 * `@noble/curves` (reached via viem's `privateKeyToAccount` at signer
 * construction) embeds RAW key material in two distinct shapes that neither
 * {@link scrubHex} (only `0x`-hex ≥41) nor {@link scrubUrl} nor key-name
 * {@link redact} can catch:
 *  - `…non-hex character "XX" at index N` — two literal characters of the key.
 *  - `expected valid private key: … got <n>` — the FULL decoded key as a
 *    decimal bigint (an in-format-but-out-of-range key), which is not `0x`-hex.
 * Both must be replaced wholesale, never merely scrubbed.
 */
export function normalizeErrorDetail(message: string): string {
  // Order matters: match the most specific secret-bearing shapes first and
  // return a constant, so no captured key material can survive downstream.
  if (/expected valid private key/i.test(message)) {
    return "malformed private key: out of range";
  }
  if (
    /non-hex character/i.test(message) ||
    /private key must be hex/i.test(message)
  ) {
    return "malformed private key: hex string expected";
  }
  // Generic defence: drop any `got <…>` / `at index N` trailers that could
  // carry captured values in shapes we have not enumerated.
  let out = message
    .replace(/\s*got\s+\S+.*$/is, "")
    .replace(/\s*at index\s+\d+/gi, "");
  if (out.length > MAX_DETAIL_LEN) {
    out = out.slice(0, MAX_DETAIL_LEN);
  }
  return out;
}

/** Scrub an error-detail string of `0x`-hex runs AND full URLs (order: hex then URL). */
export function scrubDetail(value: string): string {
  return scrubUrl(scrubHex(value));
}

/**
 * Reduce any thrown value to a safe-to-log identity: the error's
 * `constructor.name` (the real signal for viem `BaseError` subclasses; a plain
 * `@noble` throw is just `"Error"`) or the `typeof` for non-Error throws, plus a
 * normalized + scrubbed detail. The single helper every catch site must use —
 * raw `err.message` must NEVER be passed straight into a {@link log} field, or
 * the URL leak (which global {@link redact} does not catch) reopens.
 */
export function safeError(err: unknown): { errorName: string; detail: string } {
  const errorName =
    err instanceof Error ? (err.constructor?.name ?? "Error") : typeof err;
  const raw = err instanceof Error ? err.message : String(err);
  return { errorName, detail: scrubDetail(normalizeErrorDetail(raw)) };
}

/** Recursively redact one value: strings scrubbed, objects/arrays descended, primitives passed through. */
function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubHex(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  // Track only the current DFS/ancestor path: remove on return so shared
  // (diamond) sibling references are not mistaken for cycles.
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((el) => redactValue(el, seen))
    : redactRecord(value as Record<string, unknown>, seen);
  seen.delete(value);
  return result;
}

/** Redact each entry of a record, replacing secret-name values and scrubbing the rest. */
function redactRecord(
  fields: Record<string, unknown>,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEY_PATTERN.test(key)
      ? "[redacted]"
      : redactValue(value, seen);
  }
  return out;
}

/** Recursively replace secret-name values with "[redacted]" and scrub long hex runs, arrays included. */
export function redact(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  if (!fields) return {};
  return redactRecord(fields, new WeakSet());
}

/** Emit a structured JSON log line at the given level; redaction is applied unconditionally. */
export function log(
  level: "info" | "warn" | "error",
  fields: Record<string, unknown>,
): void {
  const method =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  let line: string;
  try {
    line = JSON.stringify({ level, ...redact(fields) });
  } catch {
    // Never let a serialization failure (BigInt, circular ref) crash the caller,
    // and never fall back to dumping the raw unredacted object.
    line = JSON.stringify({ level, error: "log_serialization_failed" });
  }
  method(line);
}
