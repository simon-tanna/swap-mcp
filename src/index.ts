import { Hono } from "hono";

export { SwapCoordinator } from "./coordinator/SwapCoordinator";
export { SwapMcpAgent } from "./mcp/SwapMcpAgent";
export { RateLimiter } from "./ratelimit/RateLimiter";

const app = new Hono();

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

export default app;
