/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

/** Applies drizzle-generated D1 migrations to `env.DB` before the workers test suite runs. */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
