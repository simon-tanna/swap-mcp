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
