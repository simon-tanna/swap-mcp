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
                // Test-only fakes for the secrets `validateEnv` requires. The
                // workers pool binds `vars` from wrangler.jsonc but no secrets,
                // so lazily building real engine clients (SwapCoordinator.deps)
                // needs these as plain-text bindings. The private key is a
                // well-known Anvil test key (viem can derive its address) and
                // the rpc-url carries a non-`0x` secret path so the
                // coordinator's no-leak logging is genuinely exercised.
                SWAP_PRIVATE_KEY:
                  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
                AUTH_PASSPHRASE: "test-auth-passphrase",
                UNISWAP_API_KEY: "test-uniswap-api-key",
                ETH_RPC_URL: "https://rpc.example/test-secret-path",
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
