import { z } from "zod";
import { AppError } from "../errors";

/** Decoded pagination cursor payload: creation timestamp plus row id. */
export type CursorPayload = { createdAt: number; id: string };

const cursorSchema = z
  .object({
    createdAt: z.number().int().positive(),
    id: z.string().uuid(),
  })
  .strict();

/** Encode a cursor payload as an opaque base64url string of its canonical JSON. */
export function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p)).toString("base64url");
}

/** Decode and strictly validate an opaque cursor; any failure throws AppError("invalid_input"). */
export function decodeCursor(cursor: string): CursorPayload {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return cursorSchema.parse(parsed);
  } catch {
    throw new AppError("invalid_input");
  }
}
