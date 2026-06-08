import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { oauthSelfServiceGuard } from "../src/auth/oauth-self-service-guard.js";

function appFor(role: string | null) {
  // Minimal fake Better Auth instance: only api.getSession is exercised.
  const fakeAuth = {
    api: {
      getSession: async () => (role === null ? null : { user: { role } }),
    },
  };
  const app = new Hono();
  app.use("/api/auth/oauth2/create-client", (c, next) => {
    (c as any).set("betterAuth", fakeAuth); // test seam
    return next();
  });
  app.use("/api/auth/oauth2/create-client", oauthSelfServiceGuard());
  app.post("/api/auth/oauth2/create-client", (c) => c.json({ ok: true }));
  return app;
}

describe("oauthSelfServiceGuard", () => {
  it("allows an admin session through", async () => {
    const res = await appFor("admin").request("/api/auth/oauth2/create-client", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("403s a non-admin session", async () => {
    const res = await appFor("user").request("/api/auth/oauth2/create-client", { method: "POST" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("oauth_self_service_admin_only");
  });

  it("403s an anonymous (no-session) request — fail closed", async () => {
    const res = await appFor(null).request("/api/auth/oauth2/create-client", { method: "POST" });
    expect(res.status).toBe(403);
  });
});
