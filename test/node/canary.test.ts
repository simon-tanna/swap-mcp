import { describe, expect, test } from "vitest";

describe("canary", () => {
  test("node test pool boots and runs a trivial assertion", () => {
    expect(1 + 1).toBe(2);
  });
});
