import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { edgeCache } from "../src/middleware/edge-cache.js";
import { cacheControl } from "../src/middleware/cache.js";
import { varyOnAccept } from "../src/middleware/content-negotiation.js";

/**
 * The edge cache is worker-side (Cloudflare Cache API). `bun test` has no
 * `caches` global, so we stub an in-memory store keyed by request URL —
 * matching how `caches.default` keys (URL only; the middleware folds the
 * Accept format into the key itself).
 */
class FakeCache {
  store = new Map<string, Response>();
  async match(request: Request): Promise<Response | undefined> {
    const hit = this.store.get(request.url);
    return hit ? hit.clone() : undefined;
  }
  async put(request: Request, response: Response): Promise<void> {
    this.store.set(request.url, response.clone());
  }
}

let fake: FakeCache;
const originalCaches = (globalThis as { caches?: unknown }).caches;

beforeEach(() => {
  fake = new FakeCache();
  (globalThis as { caches?: unknown }).caches = { default: fake };
});

afterEach(() => {
  (globalThis as { caches?: unknown }).caches = originalCaches;
});

type Env = { CACHE_DISABLED?: string };

function appWith(opts?: { vary?: boolean; ttl?: number; isPublic?: boolean }) {
  const ttl = opts?.ttl ?? 60;
  const isPublic = opts?.isPublic ?? true;
  let calls = 0;
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", edgeCache());
  const mws = opts?.vary
    ? [cacheControl(ttl, { isPublic }), varyOnAccept()]
    : [cacheControl(ttl, { isPublic })];
  app.use("/thing", ...mws);
  app.get("/thing", (c) => {
    calls += 1;
    return c.json({ n: calls });
  });
  return { app, calls: () => calls };
}

describe("edgeCache middleware", () => {
  it("MISS then HIT — second anonymous GET is served from cache without re-running the handler", async () => {
    const { app, calls } = appWith();

    const first = await app.request("http://x/thing", {}, {});
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Edge-Cache")).toBe("MISS");
    expect((await first.json()) as { n: number }).toEqual({ n: 1 });

    const second = await app.request("http://x/thing", {}, {});
    expect(second.headers.get("X-Edge-Cache")).toBe("HIT");
    expect((await second.json()) as { n: number }).toEqual({ n: 1 });
    expect(calls()).toBe(1); // handler ran once; HIT short-circuited
  });

  it("bypasses requests carrying an Authorization header (never serve/store shared)", async () => {
    const { app, calls } = appWith();
    // Prime the cache anonymously.
    await app.request("http://x/thing", {}, {});
    expect(calls()).toBe(1);

    const authed = await app.request(
      "http://x/thing",
      { headers: { Authorization: "Bearer x" } },
      {},
    );
    expect(authed.headers.get("X-Edge-Cache")).toBe("BYPASS");
    expect((await authed.json()) as { n: number }).toEqual({ n: 2 }); // ran the handler, fresh
    expect(calls()).toBe(2);
  });

  it("bypasses requests carrying a Cookie header", async () => {
    const { app } = appWith();
    const res = await app.request("http://x/thing", { headers: { Cookie: "s=1" } }, {});
    expect(res.headers.get("X-Edge-Cache")).toBe("BYPASS");
    expect(fake.store.size).toBe(0);
  });

  it("does not store private (non-public) responses", async () => {
    const { app } = appWith({ isPublic: false });
    const res = await app.request("http://x/thing", {}, {});
    expect(res.headers.get("X-Edge-Cache")).toBe("BYPASS");
    expect(fake.store.size).toBe(0);
  });

  it("does not store when CACHE_DISABLED is set", async () => {
    const { app } = appWith();
    const res = await app.request("http://x/thing", {}, { CACHE_DISABLED: "true" });
    expect(res.headers.get("X-Edge-Cache")).toBe("BYPASS");
    expect(fake.store.size).toBe(0);
  });

  it("does not store a max-age=0 response (boundary)", async () => {
    const { app } = appWith({ ttl: 0 });
    const res = await app.request("http://x/thing", {}, {});
    expect(res.headers.get("X-Edge-Cache")).toBe("BYPASS");
    expect(fake.store.size).toBe(0);
  });

  it("keys markdown and JSON variants separately on Vary: Accept routes", async () => {
    const { app, calls } = appWith({ vary: true });

    const json = await app.request(
      "http://x/thing",
      { headers: { Accept: "application/json" } },
      {},
    );
    expect(json.headers.get("X-Edge-Cache")).toBe("MISS");

    // Different Accept bucket → different key → MISS, not a stale JSON HIT.
    const md = await app.request("http://x/thing", { headers: { Accept: "text/markdown" } }, {});
    expect(md.headers.get("X-Edge-Cache")).toBe("MISS");
    expect(calls()).toBe(2);

    // Same JSON bucket again → HIT.
    const jsonAgain = await app.request(
      "http://x/thing",
      { headers: { Accept: "application/json" } },
      {},
    );
    expect(jsonAgain.headers.get("X-Edge-Cache")).toBe("HIT");
    expect(calls()).toBe(2);
  });

  it("does not cache non-GET requests", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", edgeCache());
    app.use("/thing", cacheControl(60, { isPublic: true }));
    app.post("/thing", (c) => c.json({ ok: true }));
    const res = await app.request("http://x/thing", { method: "POST" }, {});
    expect(res.headers.get("X-Edge-Cache")).toBeNull();
    expect(fake.store.size).toBe(0);
  });
});
