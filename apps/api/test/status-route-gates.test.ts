/**
 * Operator status routes are admin-only. `/status/fetch-plan` and
 * `/status/source-workflow` ride the `adminRoutes` namespace gate; the status
 * WebSocket has its own gate because a browser WebSocket can't send a Bearer
 * header, so it also accepts an admin cookie session from the exact web origin.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { statusStreamAuthMiddleware } from "../src/middleware/auth";
import { adminRoutes } from "../src/route-namespaces";

const ROOT = "root-secret";
const WEB = "https://releases.sh";

type SessionUser = { id: string; email: string; name: string; role?: string | null };

function streamApp(sessionUser: SessionUser | null) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set(
      "betterAuth" as never,
      {
        api: {
          getSession: async () =>
            sessionUser ? { user: sessionUser, session: { id: "s1" } } : null,
        },
      } as never,
    );
    await next();
  });
  app.use("/v1/status/ws", statusStreamAuthMiddleware);
  app.get("/v1/status/ws", (c) => c.text("upgraded"));
  return app;
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    RELEASES_API_KEY: { get: async () => ROOT },
    WEB_BASE_URL: WEB,
    ENVIRONMENT: "production",
    ...overrides,
  } as never;
}

const admin: SessionUser = { id: "u1", email: "a@example.com", name: "A", role: "admin" };
const curator: SessionUser = { id: "u2", email: "c@example.com", name: "C", role: "curator" };

describe("status route namespace gates", () => {
  it("admin-gates every operator status path except the WebSocket", () => {
    for (const path of [
      "status/fetch-log",
      "status/fetch-activity",
      "status/fetch-plan",
      "status/source-workflow",
      "status/usage",
      "status/event",
    ]) {
      expect(adminRoutes as readonly string[]).toContain(path);
    }
  });
});

describe("statusStreamAuthMiddleware", () => {
  it("rejects an anonymous caller", async () => {
    const res = await streamApp(null).request("/v1/status/ws", {}, env());
    expect(res.status).toBe(401);
  });

  it("rejects an anonymous caller that only sets the web Origin", async () => {
    const res = await streamApp(null).request("/v1/status/ws", { headers: { Origin: WEB } }, env());
    expect(res.status).toBe(401);
  });

  it("accepts the root key", async () => {
    const res = await streamApp(null).request(
      "/v1/status/ws",
      { headers: { Authorization: `Bearer ${ROOT}` } },
      env(),
    );
    expect(res.status).toBe(200);
  });

  it("accepts an admin cookie session from the web origin", async () => {
    const res = await streamApp(admin).request(
      "/v1/status/ws",
      { headers: { Origin: WEB } },
      env(),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a non-admin cookie session", async () => {
    const res = await streamApp(curator).request(
      "/v1/status/ws",
      { headers: { Origin: WEB } },
      env(),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an admin session from a sibling subdomain or another site", async () => {
    for (const origin of ["https://evil.releases.sh", "https://attacker.example", "null"]) {
      const res = await streamApp(admin).request(
        "/v1/status/ws",
        { headers: { Origin: origin } },
        env(),
      );
      expect(res.status).toBe(401);
    }
  });

  it("rejects an admin session with no Origin header", async () => {
    const res = await streamApp(admin).request("/v1/status/ws", {}, env());
    expect(res.status).toBe(401);
  });

  it("keeps the local-dev skip when no root secret is configured", async () => {
    const res = await streamApp(null).request(
      "/v1/status/ws",
      {},
      env({ RELEASES_API_KEY: undefined, ENVIRONMENT: "development" }),
    );
    expect(res.status).toBe(200);
  });
});
