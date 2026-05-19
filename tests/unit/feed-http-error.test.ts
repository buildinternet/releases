import { describe, it, expect, afterEach, mock } from "bun:test";
import {
  fetchAndParseFeed,
  FEED_4XX_INVALIDATE_THRESHOLD,
  CLEARED_FEED_FIELDS,
} from "@releases/adapters/feed";
import { FeedHttpError } from "@releases/lib/errors";

const realFetch = globalThis.fetch;

function stubFetch(status: number, statusText = ""): void {
  globalThis.fetch = mock(
    async () => new Response("", { status, statusText }),
  ) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const MINIMAL_ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>t</id><title>T</title></feed>`;

describe("fetchAndParseFeed error classification", () => {
  it("throws FeedHttpError on 4xx with status + URL preserved", async () => {
    stubFetch(404, "Not Found");

    const url = "https://example.com/changelog/rss";
    let caught: unknown;
    try {
      await fetchAndParseFeed(url, "rss");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FeedHttpError);
    const feedErr = caught as FeedHttpError;
    expect(feedErr.status).toBe(404);
    expect(feedErr.feedUrl).toBe(url);
  });

  it("throws FeedHttpError on 410 Gone", async () => {
    stubFetch(410, "Gone");
    expect(fetchAndParseFeed("https://example.com/feed.xml", "rss")).rejects.toThrow(FeedHttpError);
  });

  it("throws plain Error on 5xx (transient — no invalidation)", async () => {
    stubFetch(503, "Service Unavailable");
    let caught: unknown;
    try {
      await fetchAndParseFeed("https://example.com/feed.xml", "rss");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(FeedHttpError);
  });

  it("returns empty releases on 304 (no change)", async () => {
    stubFetch(304);
    const result = await fetchAndParseFeed("https://example.com/feed.xml", "rss");
    expect(result.releases).toEqual([]);
  });

  it("406 retry: retries with Accept: */* and succeeds when fallback returns 200", async () => {
    // Simulates Render's CDN: first request (with feed-specific Accept) returns
    // 406; fallback request with Accept: */* returns a valid feed.
    const calls: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const accept = (init?.headers as Record<string, string>)?.["Accept"] ?? "";
      calls.push(accept);
      if (accept.includes("rss+xml")) {
        return new Response("Not Acceptable", { status: 406 });
      }
      return new Response(MINIMAL_ATOM, {
        status: 200,
        headers: { "Content-Type": "application/atom+xml" },
      });
    }) as unknown as typeof fetch;

    const result = await fetchAndParseFeed("https://render.com/changelog/feed.rss", "atom");
    expect(result.releases).toHaveLength(0); // feed has no entries — parse succeeded
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("rss+xml"); // first attempt with specific Accept
    expect(calls[1]).toBe("*/*"); // fallback
  });

  it("406 retry: throws FeedHttpError if fallback also returns 406", async () => {
    // Both attempts return 406 — should not infinite-loop, must surface error.
    globalThis.fetch = (async () =>
      new Response("Not Acceptable", { status: 406 })) as unknown as typeof fetch;

    await expect(fetchAndParseFeed("https://example.com/feed.rss", "rss")).rejects.toBeInstanceOf(
      FeedHttpError,
    );
  });

  it("Accept header omits application/xml and text/xml", async () => {
    let capturedAccept = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedAccept = (init?.headers as Record<string, string>)?.["Accept"] ?? "";
      return new Response(MINIMAL_ATOM, {
        status: 200,
        headers: { "Content-Type": "application/atom+xml" },
      });
    }) as unknown as typeof fetch;

    await fetchAndParseFeed("https://example.com/feed.xml", "atom");

    expect(capturedAccept).not.toContain("application/xml");
    expect(capturedAccept).not.toContain("text/xml");
    expect(capturedAccept).toContain("application/atom+xml");
  });
});

describe("CLEARED_FEED_FIELDS", () => {
  it("undefines every feed-related metadata field at once", () => {
    // Cleanup contract: anything keyed off the old feed URL must be wiped.
    // If a new feed-tracking field is added without including it here,
    // a stale value could leak past invalidation/--no-feed-url and produce
    // misleading 304s on a freshly discovered feed.
    expect(CLEARED_FEED_FIELDS).toEqual({
      feedUrl: undefined,
      feedType: undefined,
      feedDiscoveredAt: undefined,
      feedEtag: undefined,
      feedLastModified: undefined,
      feedContentLength: undefined,
      feed4xxStreak: undefined,
    });
  });
});

describe("FEED_4XX_INVALIDATE_THRESHOLD", () => {
  it("is a small positive integer", () => {
    expect(Number.isInteger(FEED_4XX_INVALIDATE_THRESHOLD)).toBe(true);
    expect(FEED_4XX_INVALIDATE_THRESHOLD).toBeGreaterThan(0);
    expect(FEED_4XX_INVALIDATE_THRESHOLD).toBeLessThan(20);
  });
});
