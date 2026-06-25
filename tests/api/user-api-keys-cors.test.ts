import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authCorsMiddleware } from "../../workers/api/src/auth/index.js";

// Mirrors the index.ts CORS wiring: authCorsMiddleware owns credentialed CORS on
// /api/auth/*, /v1/api-keys/*, and /v1/me/*; the wildcard public cors() runs on
// every OTHER path. Without the carve-out the wildcard cors overwrites the
// credentialed Access-Control-Allow-Origin on the actual response — which a
// browser rejects for `credentials: "include"` requests (shows as "Failed to fetch").
function makeApp() {
  const app = new Hono();
  app.use("/api/auth/*", authCorsMiddleware());
  app.use("/v1/api-keys", authCorsMiddleware());
  app.use("/v1/api-keys/*", authCorsMiddleware());
  app.use("/v1/me/*", authCorsMiddleware());
  const publicReadCors = cors();
  app.use("*", (c, next) =>
    c.req.path.startsWith("/api/auth/") ||
    c.req.path === "/v1/api-keys" ||
    c.req.path.startsWith("/v1/api-keys/") ||
    c.req.path.startsWith("/v1/me/")
      ? next()
      : publicReadCors(c, next),
  );
  app.get("/v1/api-keys", (c) => c.json({ apiKeys: [] }));
  app.post("/v1/me/avatar", (c) => c.json({ avatarUrl: "https://media.test/u.png" }));
  app.post("/v1/me/workspaces/:organizationId/avatar", (c) =>
    c.json({ avatarUrl: "https://media.test/w.png" }),
  );
  app.get("/v1/orgs", (c) => c.json({ ok: true }));
  return app;
}

describe("session-authed credentialed CORS", () => {
  it("reflects the origin (not '*') with credentials on /v1/api-keys", async () => {
    const res = await makeApp().request(
      "/v1/api-keys",
      { headers: { Origin: "https://releases.sh" } },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("reflects the origin on nested /v1/me/workspaces/:id/avatar POSTs", async () => {
    const res = await makeApp().request(
      "/v1/me/workspaces/org_abc/avatar",
      {
        method: "POST",
        headers: { Origin: "https://releases.sh" },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("allows multipart avatar upload preflights (content-type header)", async () => {
    const res = await makeApp().request(
      "/v1/me/workspaces/org_abc/avatar",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://releases.sh",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "content-type",
    );
  });

  it("allows the DELETE method on a /v1/api-keys/:id revoke preflight", async () => {
    const res = await makeApp().request(
      "/v1/api-keys/ak_1",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://releases.sh",
          "Access-Control-Request-Method": "DELETE",
        },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  it("keeps wildcard CORS on other public routes", async () => {
    const res = await makeApp().request(
      "/v1/orgs",
      { headers: { Origin: "https://anything.example" } },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("wildcard CORS on a mistaken double-/v1 path breaks credentialed uploads", async () => {
    const res = await makeApp().request(
      "/v1/v1/me/workspaces/org_abc/avatar",
      {
        method: "POST",
        headers: { Origin: "https://releases.sh" },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
