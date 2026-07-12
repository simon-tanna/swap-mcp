import type { D1Migration } from "@cloudflare/vitest-pool-workers";

/** Test-only D1 migrations binding injected via `miniflare.bindings` in vitest.config.ts. */
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS?: D1Migration[];
    }
  }
}
