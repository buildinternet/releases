import type { MiddlewareHandler } from "hono";

type Env = { Bindings: { RELEASED_API_KEY: string } };

export const authMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const secret = c.env.RELEASED_API_KEY;

  // No secret configured — skip auth (local dev)
  if (!secret) {
    await next();
    return;
  }

  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (token !== secret) {
    return c.json({ error: "unauthorized", message: "Invalid or missing API key" }, 401);
  }

  await next();
};
