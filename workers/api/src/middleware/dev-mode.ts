import type { MiddlewareHandler } from "hono";

type Env = { Bindings: { DEV_MODE: string } };

export const devModeMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  if (c.env.DEV_MODE !== "true") {
    return c.json({ error: "not_found", message: "Not found" }, 404);
  }
  await next();
};
