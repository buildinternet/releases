import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";

/**
 * #1184 — wire contract for the new `--hard` purge path on `release delete
 * --source` and `source delete`. Both delete client helpers must append
 * `?hard=true` only when `{ hard: true }` is passed, so the default stays a
 * soft delete and the hard path actually frees the UNIQUE(source_id, url) slot.
 */

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

const { deleteReleasesForSource, deleteSource, deleteSources } = {
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

describe("delete --hard wire contract", () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedUrls: string[] = [];
  let capturedMethods: string[] = [];
  let responseBody = "{}";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrls = [];
    capturedMethods = [];
    responseBody = "{}";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrls.push(url);
      capturedMethods.push(String(init?.method ?? "GET"));
      return new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("deleteReleasesForSource omits ?hard by default (soft suppress)", async () => {
    responseBody = JSON.stringify({ suppressed: 3 });
    const result = await deleteReleasesForSource({ id: "src_abc" });
    expect(capturedUrls[0]).toBe("https://test.example.com/v1/sources/src_abc/releases");
    expect(capturedUrls[0]).not.toContain("hard");
    expect(capturedMethods[0]).toBe("DELETE");
    expect(result).toEqual({ suppressed: 3 });
  });

  it("deleteReleasesForSource appends ?hard=true when hard", async () => {
    responseBody = JSON.stringify({ deleted: 3, hard: true });
    const result = await deleteReleasesForSource({ id: "src_abc" }, { hard: true });
    expect(capturedUrls[0]).toBe("https://test.example.com/v1/sources/src_abc/releases?hard=true");
    expect(result).toEqual({ deleted: 3, hard: true });
  });

  it("deleteSource omits ?hard by default", async () => {
    await deleteSource({ id: "src_xyz" });
    expect(capturedUrls[0]).toBe("https://test.example.com/v1/sources/src_xyz");
    expect(capturedUrls[0]).not.toContain("hard");
  });

  it("deleteSource appends ?hard=true when hard", async () => {
    await deleteSource({ id: "src_xyz" }, { hard: true });
    expect(capturedUrls[0]).toBe("https://test.example.com/v1/sources/src_xyz?hard=true");
  });

  it("deleteSources threads hard through to each source", async () => {
    await deleteSources([{ id: "src_1" }, { id: "src_2" }], { hard: true });
    expect(capturedUrls.toSorted()).toEqual([
      "https://test.example.com/v1/sources/src_1?hard=true",
      "https://test.example.com/v1/sources/src_2?hard=true",
    ]);
  });
});
