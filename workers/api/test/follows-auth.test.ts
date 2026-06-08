import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { requireFollowsSession } from "../src/middleware/auth.js";

/** Mount the follows session gate with no injected betterAuth/cookie → getSession is null. */
function app() {
  const a = new Hono();
  a.use("/v1/me/*", requireFollowsSession);
  a.get("/v1/me/follows", (c) => c.json({ ok: true }));
  // No flag: follows is enabled by default. The gate is purely session-based.
  const env = {} as unknown as Record<string, unknown>;
  return { app: a, env };
}

describe("requireFollowsSession", () => {
  it("returns 401 when there is no session (no flag gate — follows is on by default)", async () => {
    const { app: a, env } = app();
    const res = await a.request("/v1/me/follows", {}, env);
    expect(res.status).toBe(401);
  });
});
