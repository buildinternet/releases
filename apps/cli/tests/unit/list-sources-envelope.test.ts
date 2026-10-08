import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";

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

const client = await import("../../src/api/sources.js");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const row = { id: "src_1", slug: "a", name: "A", type: "feed", url: "https://a.example" };

describe("listSourcesWithOrg envelope hardening", () => {
  let originalFetch: typeof globalThis.fetch;
  let lastUrl = "";
  let responder: () => Response;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    responder = () => json([]);
    globalThis.fetch = (async (url: string) => {
      lastUrl = String(url);
      return responder();
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes a real envelope through untouched", async () => {
    const envelope = {
      items: [row],
      pagination: {
        page: 2,
        pageSize: 5,
        returned: 1,
        totalItems: 6,
        totalPages: 2,
        hasMore: false,
      },
    };
    responder = () => json(envelope);
    const res = await client.listSourcesWithOrg({
      orgSlug: "acme",
      limit: 5,
      page: 2,
      envelope: true,
    });
    expect(res).toEqual(envelope);
    expect(lastUrl).toContain("orgSlug=acme");
    expect(lastUrl).toContain("envelope=true");
  });

  it("wraps a bare [] (unknown org on an older API) into an empty envelope", async () => {
    responder = () => json([]);
    const { items, pagination } = await client.listSourcesWithOrg({
      orgSlug: "does-not-exist",
      limit: 5,
      envelope: true,
    });
    expect(items).toEqual([]);
    expect(pagination).toMatchObject({
      page: 1,
      pageSize: 5,
      returned: 0,
      totalItems: 0,
      hasMore: false,
    });
  });

  it("wraps a populated bare array into a single-page envelope", async () => {
    responder = () => json([row]);
    const { items, pagination } = await client.listSourcesWithOrg({ limit: 50, envelope: true });
    expect(items).toHaveLength(1);
    expect(pagination).toMatchObject({ page: 1, pageSize: 50, returned: 1, hasMore: false });
  });

  it("returns the bare array when no envelope was requested", async () => {
    responder = () => json([row]);
    const res = await client.listSourcesWithOrg({ orgSlug: "acme" });
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(1);
    expect(lastUrl).not.toContain("envelope=");
  });
});

describe("normalizeSourcesEnvelope", () => {
  it("treats a null body as empty", () => {
    const out = client.normalizeSourcesEnvelope(null, { limit: 10 });
    expect(out.items).toEqual([]);
    expect(out.pagination.hasMore).toBe(false);
  });
});
