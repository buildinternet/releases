import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { SourceWithOrg } from "../../src/api/types.js";

// Mock mode.ts before importing the client — apiFetch calls getApiUrl/getApiKey
mock.module("../../src/lib/mode.js", () => ({
  getApiUrl: () => "https://test.example.com",
  getApiKey: () => "test-key",
  isRemoteMode: () => true,
  isAdminMode: () => true,
}));

const client = await import("../../src/api/client.js");

// ---------------------------------------------------------------------------
// apiFetch 404 behavior — GET vs mutating methods
// ---------------------------------------------------------------------------

describe("apiFetch 404 handling", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(status: number, body: unknown = null) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })) as any;
  }

  it("returns null for GET 404 (e.g. findSource)", async () => {
    mockFetch(404);
    const result = await client.findSource("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null for implicit GET 404 (e.g. getKnowledgePage)", async () => {
    mockFetch(404);
    const result = await client.getKnowledgePage("org", "nonexistent");
    expect(result).toBeNull();
  });

  it("throws on POST 404 (e.g. upsertKnowledgePage)", async () => {
    mockFetch(404, { message: "Not Found" });
    await expect(
      client.upsertKnowledgePage({
        scope: "org",
        orgId: "org_123",
        content: "test",
        releaseCount: 1,
      }),
    ).rejects.toThrow(/API error \(404\) on POST/);
  });

  it("throws on DELETE 404", async () => {
    mockFetch(404, { message: "Not Found" });
    await expect(client.deleteRelease("rel_123")).rejects.toThrow(
      /API error \(404\) on DELETE/,
    );
  });

  it("throws on non-404 errors for GET", async () => {
    mockFetch(500, { message: "Internal Server Error" });
    await expect(client.findSource("test")).rejects.toThrow(
      /API error \(500\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// listSourcesWithOrg — response shape conforms to shared SourceWithOrg type
// ---------------------------------------------------------------------------

describe("listSourcesWithOrg", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const apiRow: SourceWithOrg = {
    id: "src_abc123",
    name: "Next.js",
    slug: "nextjs",
    type: "github",
    url: "https://github.com/vercel/next.js",
    orgName: "Vercel",
    orgSlug: "vercel",
    productName: null,
    productSlug: null,
    isPrimary: true,
    isHidden: false,
    metadata: '{"feedUrl":"https://nextjs.org/feed.xml"}',
    releaseCount: 42,
    latestVersion: "15.3.0",
    latestDate: "2026-04-10T00:00:00Z",
    lastFetchedAt: "2026-04-15T12:00:00Z",
    fetchPriority: "normal",
    changeDetectedAt: null,
    consecutiveNoChange: 3,
    consecutiveErrors: 0,
    nextFetchAfter: null,
  };

  it("returns response preserving all SourceWithOrg fields", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([apiRow]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as any;

    const rows = await client.listSourcesWithOrg();
    expect(rows).toHaveLength(1);

    const row = rows[0];
    // Verify every field from the shared type is present and correct
    expect(row.id).toBe("src_abc123");
    expect(row.orgSlug).toBe("vercel");
    expect(row.orgName).toBe("Vercel");
    expect(row.latestVersion).toBe("15.3.0");
    expect(row.productName).toBeNull();
    expect(row.productSlug).toBeNull();
    expect(row.isPrimary).toBe(true);
    expect(row.isHidden).toBe(false);
    expect(row.consecutiveNoChange).toBe(3);
    expect(row.consecutiveErrors).toBe(0);
  });

  it("passes filter params as query string", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    await client.listSourcesWithOrg({ orgSlug: "vercel", hasFeed: true, category: "ai" });
    expect(capturedUrl).toContain("orgSlug=vercel");
    expect(capturedUrl).toContain("has_feed=true");
    expect(capturedUrl).toContain("category=ai");
  });
});
