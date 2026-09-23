/**
 * Integration: GET /v1/lookups/by-domain just-in-time manifest discovery (#2030).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { domainDemand, organizations } from "@buildinternet/releases-core/schema";
import { lookupRoutes } from "../src/routes/lookups.js";
import { createTestDb, createTestApp } from "./setup";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

afterEach(() => {
  restoreGlobalFetch();
});

const MANIFEST = {
  version: 2,
  name: "Acme",
  products: [{ name: "Widget", releases: [{ feed: "https://acme.com/widget.xml" }] }],
};

function mockManifestFetch(manifest: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(manifest), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function makeExecutionCtx() {
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { executionCtx, drain: () => Promise.all(pending) };
}

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
  };
}

describe("GET /v1/lookups/by-domain JIT (#2030)", () => {
  it("materializes a stub and returns 200 on a miss with a valid manifest", async () => {
    mockManifestFetch(MANIFEST);
    const db = createTestDb();
    const { executionCtx, drain } = makeExecutionCtx();
    const app = createTestApp(db, lookupRoutes, {
      executionCtx,
      env: {
        LISTING_SELF_SERVE_ENABLED: "true",
        LISTING_RATE_LIMITER: { limit: async () => ({ success: true }) },
        LATEST_CACHE: makeKv(),
      },
    });
    const res = await app(new Request("https://x/v1/lookups/by-domain?domain=acme.com"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      domain: string;
      org: { slug: string; status: string; locations?: unknown[] } | null;
    };
    expect(body.domain).toBe("acme.com");
    expect(body.org?.status).toBe("stub");
    expect(body.org?.locations?.length).toBeGreaterThan(0);

    await drain();
    const [demand] = await db
      .select()
      .from(domainDemand)
      .where(eq(domainDemand.domain, "acme.com"));
    // Demand is still recorded (cron backstop / analytics) even when JIT succeeds.
    expect(demand?.hitCount).toBe(1);

    const [org] = await db.select().from(organizations).where(eq(organizations.domain, "acme.com"));
    expect(org?.tier).toBe("stub");
  });

  it("404s when the manifest is missing, still records demand", async () => {
    mockManifestFetch({}, 404);
    const db = createTestDb();
    const { executionCtx, drain } = makeExecutionCtx();
    const app = createTestApp(db, lookupRoutes, {
      executionCtx,
      env: {
        LISTING_SELF_SERVE_ENABLED: "true",
        LISTING_RATE_LIMITER: { limit: async () => ({ success: true }) },
        LATEST_CACHE: makeKv(),
      },
    });
    const res = await app(new Request("https://x/v1/lookups/by-domain?domain=nope.example"));
    expect(res.status).toBe(404);
    await drain();
    const [demand] = await db
      .select()
      .from(domainDemand)
      .where(eq(domainDemand.domain, "nope.example"));
    expect(demand?.hitCount).toBe(1);
  });

  it("skips JIT when listing is disabled (demand still captured)", async () => {
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response(JSON.stringify(MANIFEST), { status: 200 });
    }) as unknown as typeof fetch;

    const db = createTestDb();
    const { executionCtx, drain } = makeExecutionCtx();
    const app = createTestApp(db, lookupRoutes, {
      executionCtx,
      env: { LISTING_SELF_SERVE_ENABLED: "false" },
    });
    const res = await app(new Request("https://x/v1/lookups/by-domain?domain=acme.com"));
    expect(res.status).toBe(404);
    expect(fetched).toBe(0);
    await drain();
    const rows = await db.select().from(domainDemand);
    expect(rows.length).toBe(1);
  });

  it("429s when the per-IP JIT limiter is exhausted", async () => {
    const db = createTestDb();
    const app = createTestApp(db, lookupRoutes, {
      env: {
        LISTING_SELF_SERVE_ENABLED: "true",
        LISTING_RATE_LIMITER: { limit: async () => ({ success: false }) },
        LATEST_CACHE: makeKv(),
      },
    });
    const res = await app(
      new Request("https://x/v1/lookups/by-domain?domain=acme.com", {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
    );
    expect(res.status).toBe(429);
  });
});
