# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Workers application built on the [Hono](https://hono.dev) framework, deployed via Wrangler. The project is named `swap-mcp` and is currently a **fresh scaffold** — `src/index.ts` contains only a single `GET /` route returning "Hello Hono!". There is no MCP server, no test suite, and no bindings wired up yet. Treat the name as intent, not implemented state.

## Commands

This project uses **pnpm** (pinned via the `packageManager` field in `package.json`). Do not use npm or yarn — it would create a competing lockfile.

```bash
pnpm install
pnpm dev         # Local dev server via `wrangler dev` (hot reload)
pnpm deploy      # Deploy to Cloudflare with `wrangler deploy --minify`
pnpm cf-typegen  # Regenerate the CloudflareBindings type from wrangler.jsonc
```

There is no lint, build, or test script configured.

## Architecture notes

- **Entry point** is `src/index.ts`, which must `export default` the Hono `app` (Workers fetch handler). This path is set by `main` in `wrangler.jsonc`.
- **Bindings** (KV, R2, D1, AI, vars, etc.) are declared in `wrangler.jsonc` — the file ships with commented-out examples for each. After adding a binding there, run `npm run cf-typegen` to regenerate the `CloudflareBindings` interface, then thread it through Hono as a generic so `c.env` is typed:
  ```ts
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  ```
- **Node APIs** are unavailable by default. To use them, uncomment `nodejs_compat` in `compatibility_flags` in `wrangler.jsonc`.
- **`compatibility_date`** in `wrangler.jsonc` pins Workers runtime behavior — bump it deliberately, not casually.
- **JSX** is configured for Hono's JSX runtime (`jsxImportSource: "hono/jsx"` in tsconfig), so `.tsx` components render server-side through Hono, not React.

## Conventions

- ESM only (`"type": "module"`), `strict` TypeScript, `ESNext` target with bundler module resolution — write modern ES/TS without transpilation-era workarounds.
