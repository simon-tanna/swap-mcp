import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/**
 * Guards the manual smoke script's two structural invariants: it exists with a
 * documented manual-only banner (§7 G11), and nothing in the automated suite can
 * import or match it, so `pnpm test` stays at zero real network (§7 G11).
 */
describe("manual smoke script", () => {
  it("smoke script exists and is excluded from the automated suite", () => {
    const smoke = readFileSync(join(repoRoot, "scripts", "smoke.ts"), "utf8");
    expect(smoke.trim().length).toBeGreaterThan(0);
    // Manual-only banner comment near the very top of the file.
    expect(smoke.slice(0, 400)).toMatch(/MANUAL SMOKE SCRIPT/);

    // No file under test/ imports scripts/smoke.ts (an `import`/`require`/
    // dynamic-`import()` referencing the smoke path). This test file names the
    // path for its own assertions, so it is excluded from the scan.
    const importRe =
      /(?:import|require|import\s*\()[^;\n]*["'][^"'\n]*scripts\/smoke/;
    const testFiles = collectFiles(join(repoRoot, "test")).filter(
      (f) => f !== fileURLToPath(import.meta.url),
    );
    for (const file of testFiles) {
      const src = readFileSync(file, "utf8");
      expect(src).not.toMatch(importRe);
    }

    // The vitest include globs only ever target test/**, never scripts/**.
    const vitestConfig = readFileSync(
      join(repoRoot, "vitest.config.ts"),
      "utf8",
    );
    const includeGlobs = [...vitestConfig.matchAll(/include:\s*\[([^\]]*)\]/g)]
      .flatMap((m) => m[1].split(","))
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0);
    expect(includeGlobs.length).toBeGreaterThan(0);
    for (const glob of includeGlobs) {
      expect(glob.startsWith("test/")).toBe(true);
      expect(glob).not.toMatch(/scripts/);
    }
  });

  it("package exposes the smoke script via tsx", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.smoke).toBe("tsx scripts/smoke.ts");
  });
});

/** Recursively collect every file path under a directory. */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}
