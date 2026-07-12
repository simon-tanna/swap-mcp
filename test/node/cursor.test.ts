import { describe, expect, test } from "vitest";
import { AppError } from "../../src/errors";
import { decodeCursor, encodeCursor } from "../../src/repository/cursor";

describe("cursor", () => {
  test("cursor round-trips (createdAt, id)", () => {
    const payload = {
      createdAt: 1720000000000,
      id: "3f3b9b3a-9c3e-4b6a-9e9a-6b0a3e9c3e4b",
    };

    const encoded = encodeCursor(payload);
    const decoded = decodeCursor(encoded);

    expect(decoded).toEqual(payload);
  });

  test("tampered cursor is rejected with invalid_input", () => {
    const encoded = encodeCursor({
      createdAt: 1720000000000,
      id: "3f3b9b3a-9c3e-4b6a-9e9a-6b0a3e9c3e4b",
    });

    // Flip the last encoded char so the decoded `id` fails strict UUID validation.
    const tampered =
      encoded.slice(0, -1) + (encoded.at(-1) === "A" ? "B" : "A");

    expect(() => decodeCursor(tampered)).toThrow(AppError);
    try {
      decodeCursor(tampered);
      throw new Error("expected decodeCursor to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("invalid_input");
    }
  });

  test("garbage cursor is rejected with invalid_input", () => {
    expect(() => decodeCursor("not-base64!!")).toThrow(AppError);
    try {
      decodeCursor("not-base64!!");
      throw new Error("expected decodeCursor to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("invalid_input");
    }
  });
});
