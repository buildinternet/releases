import type { MiddlewareHandler } from "hono";

type Env = { Bindings: { API_SECRET: string } };

export const authMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const secret = c.env.API_SECRET;
  if (!secret) {
    return c.json({ error: "unauthorized", message: "API not configured" }, 500);
  }

  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (token !== secret) {
    return c.json({ error: "unauthorized", message: "Invalid or missing API key" }, 401);
  }

  await next();
};
