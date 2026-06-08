import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { requireFollowsSession } from "../src/middleware/auth.js";

/** Minimal env with the follows flag forced on/off via the wrangler-var fallback. */
function appWith(flagValue: string | undefined) {
  const app = new Hono();
  app.use("/v1/me/*", requireFollowsSession);
  app.get("/v1/me/follows", (c) => c.json({ ok: true }));
  const env = {
    USER_FOLLOWS_ENABLED: flagValue,
    // No betterAuth injected and no cookie → getSession resolves to null.
  } as unknown as Record<string, unknown>;
  return { app, env };
}

describe("requireFollowsSession", () => {
  it("returns 404 when the follows flag is off", async () => {
    const { app, env } = appWith("false");
    const res = await app.request("/v1/me/follows", {}, env);
    expect(res.status).toBe(404);
  });

  it("returns 401 when the flag is on but there is no session", async () => {
    const { app, env } = appWith("true");
    const res = await app.request("/v1/me/follows", {}, env);
    expect(res.status).toBe(401);
  });
});
