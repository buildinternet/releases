import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { organizations } from "@buildinternet/releases-core/schema";
import { listingRoutes } from "../src/routes/listing.js";
import { createTestDb, createTestApp } from "./setup";
import { restoreGlobalFetch } from "../../../tests/global-fetch";
import { publicWriteRoutes } from "../src/route-namespaces.js";
import { mountV1Routes } from "../src/v1-routes.js";
import type { Env } from "../src/index.js";

afterEach(() => {
  restoreGlobalFetch();
});

const JSON_HEADERS = { "content-type": "application/json" };
const okLimiter = { limit: async () => ({ success: true }) };
const noLimiter = { limit: async () => ({ success: false }) };

const MANIFEST = {
  version: 2,
  name: "Acme",
  products: [{ name: "Widget", releases: [{ feed: "https://acme.com/widget.xml" }] }],
};

function mockManifestFetch(manifest: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function app(db: ReturnType<typeof createTestDb>, env: Record<string, unknown> = {}) {
  return createTestApp(db, listingRoutes, {
    env: {
      WEB_BASE_URL: "https://releases.sh",
      LISTING_RATE_LIMITER: okLimiter,
      LISTING_DOMAIN_RATE_LIMITER: okLimiter,
      ...env,
    },
  });
}

describe("POST /v1/listing/validate", () => {
  it("returns the projection for an unlisted domain, no auth required", async () => {
    mockManifestFetch(MANIFEST);
    const res = await app(createTestDb())(
      new Request("https://x/v1/listing/validate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ domain: "acme.com" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; domainStatus: string };
    expect(body.valid).toBe(true);
    expect(body.domainStatus).toBe("unlisted");
  });

  it("refuses when the kill switch is off", async () => {
    const res = await app(createTestDb(), { LISTING_SELF_SERVE_ENABLED: "false" })(
      new Request("https://x/v1/listing/validate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ domain: "acme.com" }),
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("not_found");
  });

  it("429s when the per-IP limiter says no", async () => {
    const res = await app(createTestDb(), { LISTING_RATE_LIMITER: noLimiter })(
      new Request("https://x/v1/listing/validate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ domain: "acme.com" }),
      }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("rate_limited");
  });

  it("422s a malformed body via the standard envelope", async () => {
    const res = await app(createTestDb())(
      new Request("https://x/v1/listing/validate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ nope: true }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("404s a malformed body when the kill switch is off (guard runs before body validation)", async () => {
    const res = await app(createTestDb(), { LISTING_SELF_SERVE_ENABLED: "false" })(
      new Request("https://x/v1/listing/validate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ nope: true }),
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("not_found");
  });
});

describe("POST /v1/listing/activate", () => {
  const activate = (db: ReturnType<typeof createTestDb>, body: unknown, env = {}) =>
    app(
      db,
      env,
    )(
      new Request("https://x/v1/listing/activate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      }),
    );

  it("creates a stub for an unlisted domain and returns the pointer", async () => {
    mockManifestFetch(MANIFEST);
    const db = createTestDb();
    const res = await activate(db, { domain: "acme.com" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      activated: boolean;
      org: { slug: string; status: string; webUrl: string };
      trackingRequested: boolean;
    };
    expect(body.activated).toBe(true);
    expect(body.org.status).toBe("stub");
    expect(body.trackingRequested).toBe(false);
    const [org] = await db.select().from(organizations);
    expect(org!.tier).toBe("stub");
    expect(org!.trackingRequestedAt).toBeNull();
  });

  it("stamps tracking_requested_at when requested at creation", async () => {
    mockManifestFetch(MANIFEST);
    const db = createTestDb();
    const res = await activate(db, { domain: "acme.com", requestTracking: true });
    expect(res.status).toBe(201);
    const [org] = await db.select().from(organizations);
    expect(org!.trackingRequestedAt).not.toBeNull();
  });

  it("existing-stub carve-out: no new org, refreshes the tracking stamp", async () => {
    mockManifestFetch(MANIFEST);
    const db = createTestDb();
    await activate(db, { domain: "acme.com" });
    const res = await activate(db, { domain: "acme.com", requestTracking: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activated: boolean; trackingRequested: boolean };
    expect(body.activated).toBe(false);
    expect(body.trackingRequested).toBe(true);
    const rows = await db.select().from(organizations);
    expect(rows.length).toBe(1);
    expect(rows[0]!.trackingRequestedAt).not.toBeNull();
  });

  it("409s a tracked (listed) domain with the org pointer in details", async () => {
    mockManifestFetch(MANIFEST);
    const db = createTestDb();
    await activate(db, { domain: "acme.com" });
    const [org] = await db.select().from(organizations);
    await db.update(organizations).set({ tier: "tracked" }).where(eq(organizations.id, org!.id));
    const res = await activate(db, { domain: "acme.com" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { type: string; details?: { slug?: string } } };
    expect(body.error.type).toBe("conflict");
    expect(body.error.details?.slug).toBe(org!.slug);
  });

  it("400s an invalid manifest instead of writing", async () => {
    mockManifestFetch({ version: 1 });
    const db = createTestDb();
    const res = await activate(db, { domain: "acme.com" });
    expect(res.status).toBe(400);
    expect((await db.select().from(organizations)).length).toBe(0);
  });

  it("429s when the per-domain limiter refuses", async () => {
    const res = await activate(
      createTestDb(),
      { domain: "acme.com" },
      {
        LISTING_DOMAIN_RATE_LIMITER: noLimiter,
      },
    );
    expect(res.status).toBe(429);
  });
});

describe("wiring: /v1/listing is a public-write namespace", () => {
  it("declares 'listing' as the sole publicWriteRoutes entry", () => {
    expect(publicWriteRoutes).toEqual(["listing"]);
  });

  it("mounts listingRoutes through the composed v1 router, reachable without auth headers", async () => {
    // Mirrors the real app's mount order (mountV1Routes), but without any of
    // index.ts's publicReadRoutes/adminRoutes middleware loops — proving the
    // handler itself is reached (its own guardListing 404s with the kill
    // switch explicitly off) rather than any shared auth middleware. The
    // switch MUST be off here: enabled, the handler live-fetches the domain's
    // manifest, and that real network call hangs past the test timeout on CI.
    const v1 = new Hono<Env>();
    mountV1Routes(v1);
    const composedApp = new Hono<Env>();
    composedApp.route("/v1", v1);
    const db = createTestDb();
    const res = await composedApp.fetch(
      new Request("https://x/v1/listing/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: "acme.com" }),
      }),
      { DB: db, LISTING_SELF_SERVE_ENABLED: "false" },
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    // No Authorization header was sent. A 401/403 here would mean auth
    // middleware intercepted the request before the handler's own guard ran;
    // the guard's own kill-switch 404 is the expected deterministic outcome.
    expect(res.status).toBe(404);
  });

  it("registers /listing/validate and /listing/activate in the OpenAPI spec", async () => {
    const v1 = new Hono<Env>();
    mountV1Routes(v1);
    const composedApp = new Hono<Env>();
    composedApp.route("/v1", v1);
    const res = await composedApp.fetch(
      new Request("https://x/v1/openapi.json"),
      { ENVIRONMENT: "production" },
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths?: Record<string, Record<string, unknown>> };
    expect(spec.paths?.["/listing/validate"]?.post).toBeTruthy();
    expect(spec.paths?.["/listing/activate"]?.post).toBeTruthy();
  });
});
