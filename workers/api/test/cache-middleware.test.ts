import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { cacheControl } from "../src/middleware/cache.js";

/**
 * cacheControl emits the Cache-Control header Workers Cache (wrangler
 * `cache.enabled`) reads as its freshness contract (#1580); see the
 * middleware's docstring for the Authorization exclusion rationale.
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

  it("sets Cache-Tag (comma-joined) alongside Cache-Control when tags are given", async () => {
    const app = appWith(cacheControl(60, { isPublic: true, tags: ["latest", "homepage"] }));
    const res = await app.request("http://x/releases/rel_1", {}, {});
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("cache-tag")).toBe("latest,homepage");
  });

  it("does not set Cache-Tag when no tags are given", async () => {
    const app = appWith(cacheControl(60, { isPublic: true }));
    const res = await app.request("http://x/releases/rel_1", {}, {});
    expect(res.headers.get("cache-tag")).toBeNull();
  });

  it("does not set Cache-Tag when caching is disabled (kill switch also suppresses the tag)", async () => {
    const app = appWith(cacheControl(60, { isPublic: true, tags: ["latest"] }));
    const res = await app.request("http://x/releases/rel_1", {}, { CACHE_DISABLED: "true" });
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("cache-tag")).toBeNull();
  });

  it("forces private, no-store (and no Cache-Tag) on requests bearing Authorization", async () => {
    // RFC 9111 lets `public` override the shared-cache Authorization
    // restriction, so an authed response must never advertise `public` —
    // otherwise principal-shaped fields (playbook, include_hidden rows,
    // admin projections) would land in the shared Workers Cache.
    const app = appWith(
      cacheControl(60, { staleWhileRevalidate: 30, isPublic: true, tags: ["latest"] }),
    );
    const res = await app.request(
      "http://x/releases/rel_1",
      { headers: { Authorization: "Bearer relk_test" } },
      {},
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("cache-tag")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
  });

  it("adds Vary: Authorization to anonymous cacheable responses", async () => {
    // Keeps a stored anonymous entry from ever being served to an authed
    // request (which would silently drop authed-only response fields).
    const app = appWith(cacheControl(60, { isPublic: true }));
    const res = await app.request("http://x/releases/rel_1", {}, {});
    expect(res.headers.get("vary")).toContain("Authorization");
  });
});
