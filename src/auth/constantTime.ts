/** Constant-time passphrase compare via SHA-256 digests (spec §7 G2 / M10). */
export async function timingSafeEqualDigest(
  a: string,
  b: string,
  deps?: { digest?: (data: Uint8Array) => Promise<ArrayBuffer> },
): Promise<boolean> {
  const digest =
    deps?.digest ?? ((data: Uint8Array) => crypto.subtle.digest("SHA-256", data));
  const encoder = new TextEncoder();
  // Digest first so both operands are fixed 32-byte SHA-256 outputs: this keeps
  // timingSafeEqual's equal-length requirement satisfied (closing the length-leak
  // channel) and the comparison itself constant-time (closing the char-by-char channel).
  const [digestA, digestB] = await Promise.all([
    digest(encoder.encode(a)),
    digest(encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(digestA, digestB);
}
