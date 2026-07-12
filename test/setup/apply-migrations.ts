/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

/** Applies drizzle-generated D1 migrations to `env.DB` before the workers test suite runs. */
// TEST_MIGRATIONS is typed optional to avoid polluting the shared production Cloudflare.Env
// namespace; the vitest-pool-workers config guarantees it is always bound here via
// `miniflare.bindings`, so the non-null assertion is safe in this test-only setup file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
