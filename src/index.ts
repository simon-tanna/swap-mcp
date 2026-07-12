import { Hono } from "hono";

export { SwapCoordinator } from "./coordinator/SwapCoordinator";

const app = new Hono();

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

export default app;
