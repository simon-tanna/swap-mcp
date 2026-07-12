import { describe, expect, test } from "vitest";

import { publicApp } from "../../src/oauth/publicApp";

describe("publicApp /healthz", () => {
  test("GET /healthz returns 200 with the constant body", async () => {
    const res = await publicApp.request("/healthz");

    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ status: "ok" });
  });

  test("healthz does not branch on env presence", async () => {
    const normal = await publicApp.request("/healthz");
    const emptyEnv = await publicApp.request("/healthz", {}, {});

    expect(emptyEnv.status).toBe(200);

    const normalText = await normal.text();
    const emptyEnvText = await emptyEnv.text();

    expect(JSON.parse(emptyEnvText)).toStrictEqual({ status: "ok" });
    // Byte-identical body across both calls proves there is no env/binding oracle.
    expect(normalText).toBe(emptyEnvText);
  });
});
