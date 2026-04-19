import { describe, it, expect } from "bun:test";
import {
  inferFeedTypeFromUrl,
  resolveFeedUpdate,
  VALID_FEED_TYPES,
} from "@releases/lib/source-edit";

describe("inferFeedTypeFromUrl", () => {
  it("returns jsonfeed for .json extensions", () => {
    expect(inferFeedTypeFromUrl("https://example.com/feed.json")).toBe("jsonfeed");
  });

  it("returns atom when the URL contains 'atom'", () => {
    expect(inferFeedTypeFromUrl("https://example.com/atom.xml")).toBe("atom");
  });

  it("defaults to rss for extension-less paths", () => {
    expect(inferFeedTypeFromUrl("https://example.com/changelog/rss")).toBe("rss");
  });
});

describe("resolveFeedUpdate", () => {
  it("is a no-op when neither flag is passed", () => {
    const result = resolveFeedUpdate({});
    expect(result).toEqual({ ok: true, action: "none" });
  });

  it("removes the feed when --no-feed-url is passed (feedUrl=false)", () => {
    const result = resolveFeedUpdate({ feedUrl: false });
    expect(result).toEqual({ ok: true, action: "remove" });
  });

  it("infers feed type from the URL when --feed-type is absent", () => {
    const result = resolveFeedUpdate({ feedUrl: "https://example.com/feed.xml" });
    expect(result).toEqual({
      ok: true,
      action: "set",
      feedUrl: "https://example.com/feed.xml",
      feedType: "rss",
    });
  });

  it("lets --feed-type override the URL-inferred type", () => {
    // URL ends in nothing feed-shaped; without override we'd guess rss.
    const result = resolveFeedUpdate({
      feedUrl: "https://example.com/changelog/rss",
      feedType: "atom",
    });
    expect(result).toEqual({
      ok: true,
      action: "set",
      feedUrl: "https://example.com/changelog/rss",
      feedType: "atom",
    });
  });

  it("uses the explicit type even when inference would disagree", () => {
    const result = resolveFeedUpdate({
      feedUrl: "https://example.com/feed.json",
      feedType: "rss",
    });
    expect(result).toEqual({
      ok: true,
      action: "set",
      feedUrl: "https://example.com/feed.json",
      feedType: "rss",
    });
  });

  it("errors when --feed-type is passed without --feed-url", () => {
    const result = resolveFeedUpdate({ feedType: "rss" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("--feed-url");
    }
  });

  it("errors when --feed-type is passed with --no-feed-url", () => {
    // --no-feed-url sets feedUrl to false, which is not a string → same error.
    const result = resolveFeedUpdate({ feedUrl: false, feedType: "atom" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("--feed-url");
    }
  });

  it("errors with a helpful message on invalid --feed-type values", () => {
    const result = resolveFeedUpdate({
      feedUrl: "https://example.com/feed.xml",
      feedType: "garbage",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(`"garbage"`);
      for (const t of VALID_FEED_TYPES) {
        expect(result.error).toContain(t);
      }
    }
  });

  it("accepts every value in VALID_FEED_TYPES", () => {
    for (const t of VALID_FEED_TYPES) {
      const result = resolveFeedUpdate({
        feedUrl: "https://example.com/feed",
        feedType: t,
      });
      expect(result.ok).toBe(true);
      if (result.ok && result.action === "set") {
        expect(result.feedType).toBe(t);
      }
    }
  });
});
