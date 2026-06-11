import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { cacheControl } from "../src/middleware/cache.js";

/**
 * cacheControl is headers-only — there is no worker-side cache (no Cache API,
 * no KV) behind these routes, so the emitted Cache-Control header IS the
 * freshness contract any downstream HTTP cache is permitted to honor (#1580).
 */

type Env = { CACHE_DISABLED?: string };

function appWith(mw: ReturnType<typeof cacheControl>) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/releases/:id", mw);
  app.get("/releases/:id", (c) => c.json({ id: c.req.param("id") }));
  app.post("/releases/:id", (c) => c.json({ ok: true }));
  app.get("/missing-status", mw, (c) => c.json({ error: "not found" }, 404));
  app.get("/preset", mw, (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true });
  });
  return app;
}

describe("cacheControl middleware", () => {
  it("emits the single-entity 60s/SWR-30 public profile used by /releases/:id", async () => {
    const app = appWith(cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
    const res = await app.request("http://x/releases/rel_1", {}, {});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=30");
  });

  it("defaults to private with no SWR", async () => {
    const app = appWith(cacheControl(15));
    const res = await app.request("http://x/releases/rel_1", {}, {});
    expect(res.headers.get("cache-control")).toBe("private, max-age=15");
  });

  it("does not set the header on non-GET requests", async () => {
    const app = appWith(cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
    const res = await app.request("http://x/releases/rel_1", { method: "POST" }, {});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("does not set the header on non-2xx responses", async () => {
    const app = appWith(cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
    const res = await app.request("http://x/missing-status", {}, {});
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("never overrides a handler-set Cache-Control", async () => {
    const app = appWith(cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
    const res = await app.request("http://x/preset", {}, {});
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is skipped when CACHE_DISABLED is set", async () => {
    const app = appWith(cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
    const res = await app.request("http://x/releases/rel_1", {}, { CACHE_DISABLED: "true" });
    expect(res.headers.get("cache-control")).toBeNull();
  });
});
