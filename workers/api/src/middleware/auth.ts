import type { MiddlewareHandler } from "hono";
import type { Env } from "../index.js";

export const authMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const secret = await c.env.RELEASED_API_KEY?.get();

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
