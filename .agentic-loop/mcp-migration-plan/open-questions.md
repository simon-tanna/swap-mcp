# Open questions — none outstanding

## RESOLVED 2026-07-13 — T31 token-audience model
Decision: **Option A — origin-only canonical resource.** `CANONICAL_MCP_URI` becomes the Worker origin (`https://swap-mcp.example.workers.dev`, no `/mcp` path) so one operator token authorizes both `/mcp` and `/api` (preserves spec G2). Applied consistently across the consent resource check (T29/T30), the app-level audience assertion (T24), the integration mint flow (T31), the `CANONICAL_MCP_URI` var, and all affected tests. M12 foreign-resource rejection preserved (accepts the origin, still rejects any foreign resource). Full details + rationale in progress.log.
