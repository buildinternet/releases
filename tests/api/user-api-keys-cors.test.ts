import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authCorsMiddleware } from "../../workers/api/src/auth/index.js";

// Mirrors the index.ts CORS wiring: authCorsMiddleware owns credentialed CORS on
// /api/auth/* AND /v1/api-keys/*, and the wildcard public cors() runs on every
// OTHER path. Without the carve-out the wildcard cors overwrites the credentialed
// Access-Control-Allow-Origin on the actual /v1/api-keys response.
function makeApp() {
  const app = new Hono();
  app.use("/api/auth/*", authCorsMiddleware());
  app.use("/v1/api-keys", authCorsMiddleware());
  app.use("/v1/api-keys/*", authCorsMiddleware());
  const publicReadCors = cors();
  app.use("*", (c, next) =>
    c.req.path.startsWith("/api/auth/") ||
    c.req.path === "/v1/api-keys" ||
    c.req.path.startsWith("/v1/api-keys/")
      ? next()
      : publicReadCors(c, next),
  );
  app.get("/v1/api-keys", (c) => c.json({ apiKeys: [] }));
  app.get("/v1/orgs", (c) => c.json({ ok: true }));
  return app;
}

describe("/v1/api-keys credentialed CORS", () => {
  it("reflects the origin (not '*') with credentials on /v1/api-keys", async () => {
    const res = await makeApp().request(
      "/v1/api-keys",
      { headers: { Origin: "https://releases.sh" } },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("keeps wildcard CORS on other public routes", async () => {
    const res = await makeApp().request(
      "/v1/orgs",
      { headers: { Origin: "https://anything.example" } },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
