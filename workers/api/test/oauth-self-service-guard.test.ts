import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { oauthSelfServiceGuard } from "../src/auth/oauth-self-service-guard.js";

const WRITE_PATHS = [
  "/api/auth/oauth2/create-client",
  "/api/auth/oauth2/update-client",
  "/api/auth/oauth2/delete-client",
  "/api/auth/oauth2/client/rotate-secret",
];

/** `role`: "admin"|"user"|null (no session)|"throw" (getSession rejects). */
function appFor(role: string | null | "throw", path = WRITE_PATHS[0]) {
  // Minimal fake Better Auth instance: only api.getSession is exercised.
  const fakeAuth = {
    api: {
      getSession: async () => {
        if (role === "throw") throw new Error("DB unavailable");
        return role === null ? null : { user: { role } };
      },
    },
  };
  const app = new Hono();
  app.use(path, (c, next) => {
    (c as any).set("betterAuth", fakeAuth); // test seam
    return next();
  });
  app.use(path, oauthSelfServiceGuard());
  app.post(path, (c) => c.json({ ok: true }));
  return app;
}

describe("oauthSelfServiceGuard", () => {
  it("allows an admin session through", async () => {
    const res = await appFor("admin").request(WRITE_PATHS[0], { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("403s a non-admin session", async () => {
    const res = await appFor("user").request(WRITE_PATHS[0], { method: "POST" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("oauth_self_service_admin_only");
  });

  it("403s an anonymous (no-session) request — fail closed", async () => {
    const res = await appFor(null).request(WRITE_PATHS[0], { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("403s when getSession throws — fail closed on error", async () => {
    const res = await appFor("throw").request(WRITE_PATHS[0], { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("guards every write path for a non-admin (no path slips through)", async () => {
    for (const p of WRITE_PATHS) {
      const res = await appFor("user", p).request(p, { method: "POST" });
      expect(res.status).toBe(403);
    }
  });
});
