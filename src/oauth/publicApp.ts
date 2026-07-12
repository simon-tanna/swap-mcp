import { Hono } from "hono";

// publicApp is the OAuthProvider's PUBLIC (unauthenticated) handler.
// Every route here must be safe to expose with no auth. `/healthz` in
// particular must be a CONSTANT response — it must never read env/bindings
// or branch on their presence, so it can't become an oracle that leaks
// whether a binding/secret is configured (spec §5.13, G1).
export const publicApp = new Hono();

publicApp.get("/healthz", (c) => c.json({ status: "ok" }));
