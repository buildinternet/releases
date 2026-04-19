import { describe, it, expect } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";

// The worker middleware modules define their own narrower Env types that don't
// perfectly align with a standalone Hono<Env> generic.  We cast to the general
// MiddlewareHandler so the test-only Hono app accepts them without pulling in
// the full Cloudflare Workers type surface.
const { authMiddleware } = (await import(
  "../../workers/api/src/middleware/auth.js"
)) as unknown as {
  authMiddleware: MiddlewareHandler;
};

const { cacheControl } = (await import("../../workers/api/src/middleware/cache.js")) as unknown as {
  cacheControl: (
    maxAge: number,
    options?: { staleWhileRevalidate?: number; isPublic?: boolean },
  ) => MiddlewareHandler;
};

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

describe("authMiddleware", () => {
  /** Create a mock SecretBinding that returns the given value from .get() */
  function mockSecret(value: string) {
    return { get: () => Promise.resolve(value) };
  }

  function createApp() {
    type Env = { Bindings: { RELEASED_API_KEY?: { get(): Promise<string> } } };
    const app = new Hono<Env>();
    app.use("*", authMiddleware);
    app.get("/test", (c) => c.json({ ok: true }));
    return app;
  }

  it("returns 401 when no Authorization header is provided", async () => {
    const app = createApp();
    const res = await app.request("/test", {}, { RELEASED_API_KEY: mockSecret("secret") });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("returns 401 for an invalid bearer token", async () => {
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { Authorization: "Bearer wrong-key" } },
      { RELEASED_API_KEY: mockSecret("secret") },
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 for a valid bearer token", async () => {
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { Authorization: "Bearer secret" } },
      { RELEASED_API_KEY: mockSecret("secret") },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("skips auth when no API key binding is present (local dev)", async () => {
    const app = createApp();
    const res = await app.request("/test", {}, {});
    expect(res.status).toBe(200);
  });

  it("returns 401 for non-Bearer auth schemes", async () => {
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { Authorization: "Basic dXNlcjpwYXNz" } },
      { RELEASED_API_KEY: mockSecret("secret") },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization header is just 'Bearer' with no token", async () => {
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { Authorization: "Bearer " } },
      { RELEASED_API_KEY: mockSecret("secret") },
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Cache-Control middleware
// ---------------------------------------------------------------------------

describe("cacheControl", () => {
  function createApp(
    maxAge: number,
    options?: { staleWhileRevalidate?: number; isPublic?: boolean },
    env: { CACHE_DISABLED?: string } = {},
  ) {
    type Env = { Bindings: { CACHE_DISABLED?: string } };
    const app = new Hono<Env>();
    app.use("*", cacheControl(maxAge, options));
    app.get("/test", (c) => c.json({ ok: true }));
    app.post("/test", (c) => c.json({ created: true }, 201));
    app.get("/error", (c) => c.json({ error: "not found" }, 404));
    app.get("/preset", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ ok: true });
    });
    return { app, env };
  }

  it("sets Cache-Control on successful GET responses", async () => {
    const { app, env } = createApp(60);
    const res = await app.request("/test", { method: "GET" }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
  });

  it("does NOT set Cache-Control on non-GET methods", async () => {
    const { app, env } = createApp(60);
    const res = await app.request("/test", { method: "POST" }, env);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("does NOT set Cache-Control on error responses", async () => {
    const { app, env } = createApp(60);
    const res = await app.request("/error", { method: "GET" }, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("includes stale-while-revalidate when configured", async () => {
    const { app, env } = createApp(300, { staleWhileRevalidate: 60 });
    const res = await app.request("/test", { method: "GET" }, env);
    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=300, stale-while-revalidate=60",
    );
  });

  it("uses public visibility when isPublic is true", async () => {
    const { app, env } = createApp(120, { isPublic: true });
    const res = await app.request("/test", { method: "GET" }, env);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=120");
  });

  it("uses private visibility by default", async () => {
    const { app, env } = createApp(60);
    const res = await app.request("/test", { method: "GET" }, env);
    expect(res.headers.get("Cache-Control")).toContain("private");
  });

  it("skips caching when CACHE_DISABLED is set", async () => {
    const { app } = createApp(60);
    const res = await app.request("/test", { method: "GET" }, { CACHE_DISABLED: "1" });
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("does NOT overwrite existing Cache-Control headers", async () => {
    const { app, env } = createApp(60);
    const res = await app.request("/preset", { method: "GET" }, env);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
