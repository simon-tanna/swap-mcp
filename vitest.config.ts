// Verified: readD1Migrations and cloudflareTest are both exported from the
// package root ("@cloudflare/vitest-pool-workers") in @cloudflare/vitest-pool-workers@0.18.4 —
// the "/config" subpath referenced in some docs/comments does not exist in this version's exports map.
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/node/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations("./drizzle"),
              },
            },
          })),
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
          setupFiles: ["./test/setup/apply-migrations.ts"],
        },
      },
    ],
  },
});
