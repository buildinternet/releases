import { describe, it, expect, afterEach } from "bun:test";
import { listingRoutes } from "../src/routes/listing.js";
import { createTestDb, createTestApp } from "./setup";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

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
    expect([400, 422]).toContain(res.status);
  });
});
