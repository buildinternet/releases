import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";

// Drive the real client via env (a top-level mock.module leaks across files —
// see api-client.test.ts). Match request paths by suffix, not full URL, so the
// process-wide getApiUrl() memoization can't poison assertions.
const prevEnv: { url?: string; key?: string } = {};
beforeAll(() => {
  prevEnv.url = process.env.RELEASES_API_URL;
  prevEnv.key = process.env.RELEASES_API_KEY;
  process.env.RELEASES_API_URL = "https://test.example.com";
  process.env.RELEASES_API_KEY = "test-key";
});
afterAll(() => {
  if (prevEnv.url === undefined) delete process.env.RELEASES_API_URL;
  else process.env.RELEASES_API_URL = prevEnv.url;
  if (prevEnv.key === undefined) delete process.env.RELEASES_API_KEY;
  else process.env.RELEASES_API_KEY = prevEnv.key;
});

const client = {
  ...(await import("../../src/api/core.js")),
  ...(await import("../../src/api/admin.js")),
  ...(await import("../../src/api/collections.js")),
  ...(await import("../../src/api/follows.js")),
  ...(await import("../../src/api/orgs.js")),
  ...(await import("../../src/api/products.js")),
  ...(await import("../../src/api/releases.js")),
  ...(await import("../../src/api/sources.js")),
  ...(await import("../../src/api/webhooks.js")),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Minimal org/product detail bodies (only id/slug/name are read by the resolver).
const orgBody = (id: string, slug: string, name: string) => ({ id, slug, name });
const productBody = (id: string, slug: string, name: string) => ({ id, slug, name });

describe("follows client wire contract", () => {
  let originalFetch: typeof globalThis.fetch;
  let calls: Array<{ url: string; method: string; body: unknown }> = [];
  // Per-call responder — reads the just-captured URL so multi-fetch flows
  // (resolveFollowTarget) can return different shapes per path.
  let responder: (url: string) => Response;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    responder = () => json({});
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        url: u,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return responder(u);
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("addFollow POSTs /v1/me/follows with the target body", async () => {
    responder = () => json({ success: true, following: true }, 201);
    const res = await client.addFollow("org", "org_a");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.endsWith("/v1/me/follows")).toBe(true);
    expect(calls[0]!.body).toEqual({ targetType: "org", targetId: "org_a" });
    expect(res).toEqual({ success: true, following: true });
  });

  it("removeFollow DELETEs /v1/me/follows/:type/:id", async () => {
    responder = () => json({ success: true, following: false });
    await client.removeFollow("product", "prod_w");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.endsWith("/v1/me/follows/product/prod_w")).toBe(true);
  });

  it("listMyFollows GETs /v1/me/follows and unwraps the array", async () => {
    responder = () =>
      json({
        follows: [
          {
            targetType: "org",
            targetId: "org_a",
            name: "Acme",
            slug: "acme",
            orgSlug: null,
            createdAt: "2026-06-01T00:00:00Z",
          },
        ],
      });
    const follows = await client.listMyFollows();
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.endsWith("/v1/me/follows")).toBe(true);
    expect(follows).toHaveLength(1);
    expect(follows[0]).toMatchObject({ targetId: "org_a", name: "Acme" });
  });

  it("listMyFollows returns [] when the route 404s", async () => {
    responder = () => json({ error: "not_found" }, 404);
    expect(await client.listMyFollows()).toEqual([]);
  });

  it("getMyFeed forwards pagination and maps items to renderable rows", async () => {
    responder = () =>
      json({
        items: [
          {
            id: "rel_1",
            version: "1.2.0",
            title: "v1.2.0",
            summary: "Dark mode",
            titleGenerated: null,
            titleShort: "Dark mode",
            publishedAt: "2026-06-01T00:00:00Z",
            media: [],
            source: { slug: "acme-blog", name: "Acme Blog", type: "feed" },
            product: { slug: "widget", name: "Widget" },
          },
        ],
        pagination: { hasMore: true },
      });
    const { releases, hasMore } = await client.getMyFeed({ page: 2, limit: 10 });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v1/me/feed?");
    expect(calls[0]!.url).toContain("page=2");
    expect(calls[0]!.url).toContain("limit=10");
    expect(hasMore).toBe(true);
    expect(releases).toHaveLength(1);
    // toLatestRelease flattens source → sourceName/sourceSlug for the renderer.
    expect(releases[0]).toMatchObject({
      id: "rel_1",
      sourceName: "Acme Blog",
      sourceSlug: "acme-blog",
    });
  });
});

describe("resolveFollowTarget", () => {
  let originalFetch: typeof globalThis.fetch;
  let responder: (url: string) => Response;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    responder = () => new Response(JSON.stringify({}), { status: 404 });
    globalThis.fetch = (async (url: string) =>
      responder(String(url))) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves an org_ id via the org route", async () => {
    responder = (u) =>
      u.includes("/v1/orgs/") ? json(orgBody("org_a", "acme", "Acme")) : json({}, 404);
    const t = await client.resolveFollowTarget("org_a");
    expect(t).toEqual({ targetType: "org", targetId: "org_a", label: "Acme" });
  });

  it("resolves a prod_ id via the product route", async () => {
    responder = (u) =>
      u.includes("/v1/products/prod_w")
        ? json(productBody("prod_w", "widget", "Widget"))
        : json({}, 404);
    const t = await client.resolveFollowTarget("prod_w");
    expect(t).toEqual({ targetType: "product", targetId: "prod_w", label: "Widget" });
  });

  it("resolves an org/slug coordinate to a product", async () => {
    responder = (u) =>
      u.includes("/v1/orgs/acme/products/widget")
        ? json(productBody("prod_w", "widget", "Widget"))
        : json({}, 404);
    const t = await client.resolveFollowTarget("acme/widget");
    expect(t).toEqual({ targetType: "product", targetId: "prod_w", label: "Widget" });
  });

  it("prefers an org for a bare term that matches an org", async () => {
    responder = (u) =>
      u.includes("/v1/orgs/vercel") ? json(orgBody("org_v", "vercel", "Vercel")) : json({}, 404);
    const t = await client.resolveFollowTarget("vercel");
    expect(t).toEqual({ targetType: "org", targetId: "org_v", label: "Vercel" });
  });

  it("returns null when nothing resolves", async () => {
    // org route 404s; product slug-lookup 404s → null.
    responder = () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    expect(await client.resolveFollowTarget("nope-nothing")).toBeNull();
  });
});
