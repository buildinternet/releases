import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

// Mock mode.ts before importing the client — apiFetch calls getApiUrl/getApiKey
mock.module("../../src/lib/mode.js", () => ({
  getApiUrl: () => "https://test.example.com",
  getApiKey: () => "test-key",
  isRemoteMode: () => true,
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

  it("returns null for GET 404 (e.g. findSourceBySlug)", async () => {
    mockFetch(404);
    const result = await client.findSourceBySlug("nonexistent");
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
    await expect(client.findSourceBySlug("test")).rejects.toThrow(
      /API error \(500\)/,
    );
  });
});
