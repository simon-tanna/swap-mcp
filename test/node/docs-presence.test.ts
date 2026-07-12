import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { ERROR_CODES } from "../../src/errors";

/** Absolute path to a repo-relative file, resolved from the vitest working directory (repo root). */
function repoPath(relative: string): string {
  return resolve(process.cwd(), relative);
}

/** Read a repo-relative UTF-8 file; a missing file throws `ENOENT` (the intended red). */
function readDoc(relative: string): string {
  return readFileSync(repoPath(relative), "utf8");
}

/** The six Diátaxis artifacts, one per quadrant plus the two named how-to runbooks. */
const DOCS = {
  tutorial: "docs/tutorials/getting-started.md",
  configureDeploy: "docs/how-to/configure-secrets-and-deploy.md",
  approval: "docs/how-to/one-time-usdc-approval.md",
  reconcile: "docs/how-to/reconcile-stranded-submitted.md",
  reference: "docs/reference/api-and-data-model.md",
  explanation: "docs/explanation/architecture-decisions.md",
} as const;

describe("docs presence (Diátaxis)", () => {
  test("one artifact exists per Diátaxis quadrant", () => {
    for (const relative of Object.values(DOCS)) {
      expect(readDoc(relative).trim().length).toBeGreaterThan(0);
    }
  });

  test("the reconciliation runbook exists by its spec-mandated name and notes the pending-row rule", () => {
    const doc = readDoc(DOCS.reconcile);
    expect(doc.trim().length).toBeGreaterThan(0);
    expect(doc).toMatch(/pending.*no.*txHash.*safe.*failed/i);
  });

  test("the one-time approval how-to exists", () => {
    expect(readDoc(DOCS.approval).trim().length).toBeGreaterThan(0);
  });

  test("reference covers the full error allowlist", () => {
    const doc = readDoc(DOCS.reference);
    for (const code of ERROR_CODES) {
      expect(doc).toContain(code);
    }
  });

  test("the explanation doc carries the mutex-eviction caveat", () => {
    expect(readDoc(DOCS.explanation)).toMatch(/mutex.*(evict|hibernat)/i);
  });

  test("the deploy how-to carries the migrations-tag and global-lockout notes", () => {
    const doc = readDoc(DOCS.configureDeploy);
    expect(doc).toMatch(/migration.*tag/i);
    expect(doc).toMatch(/global/i);
    expect(doc).toMatch(/lock/i);
  });
});
