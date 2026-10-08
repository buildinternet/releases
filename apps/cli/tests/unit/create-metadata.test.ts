import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drive the real mode.ts via env (a top-level mock.module leaks across files —
// see api-client.test.ts).
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

const { createSourceAction } = await import("../../src/cli/commands/create.js");

/**
 * #237 — `source create` could not set feed filters / metadata, so the only way
 * to filter a feed was a follow-up `source update --metadata-set` that raced the
 * onboard auto-fetch (which read metadata first → ingested the unfiltered feed).
 * These tests pin that the metadata travels in the create POST body, atomically.
 */
describe("source create metadata flags", () => {
  let originalFetch: typeof globalThis.fetch;
  let dir: string;
  let postBody: Record<string, unknown> | null = null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    dir = mkdtempSync(join(tmpdir(), "rel-create-meta-"));
    process.env.RELEASES_RUN_DIR = dir;
    postBody = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/sources")) {
        postBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "src_new",
            slug: "release-notes",
            name: "Release Notes",
            type: "feed",
            url: "https://discord.com/blog",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // GET findSourcesByUrls() → no existing source at this URL.
      if (url.includes("filterByUrls=true")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      // GET findBlockedUrl() → not excluded (404 → null).
      return new Response("null", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.RELEASES_RUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("packs --keyword-allow into metadata.feedKeywordAllow on create", async () => {
    await createSourceAction("Release Notes", {
      url: "https://discord.com/blog",
      type: "feed",
      feedUrl: "https://discord.com/blog/rss.xml",
      keywordAllow: "changelog, patch-notes",
    });
    expect(postBody).not.toBeNull();
    const meta = JSON.parse(String((postBody as { metadata?: string }).metadata));
    expect(meta.feedKeywordAllow).toEqual(["changelog", "patch-notes"]);
    // feed-url metadata still rides along.
    expect(meta.feedUrl).toBe("https://discord.com/blog/rss.xml");
  });

  it("packs --metadata-set tokens with type coercion", async () => {
    await createSourceAction("Release Notes", {
      url: "https://discord.com/blog",
      type: "feed",
      metadataSet: ["marketingFilter=true", "feedContentDepth=summary-only"],
    });
    const meta = JSON.parse(String((postBody as { metadata?: string }).metadata));
    expect(meta.marketingFilter).toBe(true); // coerced to boolean
    expect(meta.feedContentDepth).toBe("summary-only");
  });

  it("omits metadata entirely when no metadata flags are given", async () => {
    await createSourceAction("Plain", {
      url: "https://example.com/changelog",
      type: "scrape",
    });
    expect((postBody as { metadata?: string }).metadata).toBeUndefined();
  });
});
