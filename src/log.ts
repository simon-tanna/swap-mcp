/** Case-insensitive pattern matching key names that carry secret material. */
const SECRET_KEY_PATTERN =
  /(private[_-]?key|passphrase|api[_-]?key|authorization|auth[_-]?token|bearer|secret|password|mnemonic|seed|rpc[_-]?url)/i;

/** Matches `0x`-prefixed hex runs longer than a 42-char (20-byte) address. */
const LONG_HEX_PATTERN = /0x[0-9a-fA-F]{41,}/g;

/** Scrub any over-length hex run from a string, leaving 42-char addresses intact. */
export function scrubHex(value: string): string {
  return value.replace(LONG_HEX_PATTERN, "[redacted]");
}

/** Recursively replace secret-name values with "[redacted]" and scrub long hex runs from strings. */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[redacted]";
    } else if (typeof value === "string") {
      out[key] = scrubHex(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redact(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Emit a structured JSON log line at the given level; redaction is applied unconditionally. */
export function log(
  level: "info" | "warn" | "error",
  fields: Record<string, unknown>,
): void {
  const line = JSON.stringify({ level, ...redact(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
