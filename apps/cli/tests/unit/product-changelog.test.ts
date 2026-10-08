import { describe, expect, it } from "bun:test";
import type { LatestRelease } from "../../src/api/types.js";
import {
  CHANGELOG_FEED_URL,
  CHANGELOG_PAGE_URL,
  changelogKindFromSource,
  clampChangelogLimit,
  fetchProductChangelog,
  formatChangelogHuman,
  releasePermalink,
  toChangelogEntry,
} from "../../src/lib/product-changelog.js";

const PLATFORM: LatestRelease = {
  id: "rel_platform",
  title: "September 9, 2026",
  version: null,
  publishedAt: "2026-09-09T12:00:00.000Z",
  sourceName: "Changelog",
  sourceSlug: "product-changelog",
  summary: "Source changelog pages no longer 500.",
  titleGenerated: null,
  titleShort: null,
  contentChars: 213,
  contentTokens: 51,
  importance: 2,
  media: [],
  product: null,
};

const CLI: LatestRelease = {
  id: "rel_cli",
  title: "v0.74.1",
  version: "v0.74.1",
  publishedAt: "2026-08-24T22:10:12.000Z",
  sourceName: "Releases CLI",
  sourceSlug: "releases-cli",
  summary: "Unified feedback onto the shared apiFetch transport.",
  titleGenerated: null,
  titleShort: null,
  contentChars: 408,
  contentTokens: 103,
  importance: 2,
  media: [],
  product: null,
};

describe("changelogKindFromSource", () => {
  it("treats product-changelog as platform and everything else as cli", () => {
    expect(changelogKindFromSource("product-changelog")).toBe("platform");
    expect(changelogKindFromSource("releases-cli")).toBe("cli");
    expect(changelogKindFromSource("releases")).toBe("cli");
    expect(changelogKindFromSource("")).toBe("cli");
  });
});

describe("toChangelogEntry", () => {
  it("maps a latest-release row onto the changelog document shape", () => {
    expect(toChangelogEntry(PLATFORM)).toEqual({
      id: "rel_platform",
      kind: "platform",
      title: "September 9, 2026",
      date: "2026-09-09T12:00:00.000Z",
      url: "https://releases.sh/release/rel_platform",
      tags: ["product-changelog"],
      summary: "Source changelog pages no longer 500.",
      body: "Source changelog pages no longer 500.",
    });
  });

  it("tags CLI cuts as kind cli", () => {
    expect(toChangelogEntry(CLI).kind).toBe("cli");
    expect(toChangelogEntry(CLI).tags).toEqual(["releases-cli"]);
  });
});

describe("clampChangelogLimit", () => {
  it("defaults, clamps high values, and rejects non-positive as the default", () => {
    expect(clampChangelogLimit(undefined)).toBe(5);
    expect(clampChangelogLimit(2)).toBe(2);
    expect(clampChangelogLimit(999)).toBe(50);
    expect(clampChangelogLimit(0)).toBe(5);
  });
});

describe("formatChangelogHuman", () => {
  it("prints titles, dates, summaries, and a link to /updates", () => {
    const text = formatChangelogHuman({
      url: CHANGELOG_PAGE_URL,
      feed: CHANGELOG_FEED_URL,
      entries: [toChangelogEntry(PLATFORM), toChangelogEntry(CLI)],
    });
    expect(text).toContain("What's new");
    expect(text).toContain("September 9, 2026");
    expect(text).toContain("Sep 9, 2026");
    expect(text).toContain(releasePermalink("rel_platform"));
    expect(text).toContain("Source changelog pages no longer 500.");
    expect(text).toContain("v0.74.1");
    expect(text).toMatch(/See all updates: https:\/\/releases\.sh\/updates\n$/);
  });

  it("still links to the page when there are no entries", () => {
    const text = formatChangelogHuman({
      url: CHANGELOG_PAGE_URL,
      feed: CHANGELOG_FEED_URL,
      entries: [],
    });
    expect(text).toContain("No changelog entries.");
    expect(text).toContain(`See all updates: ${CHANGELOG_PAGE_URL}`);
  });
});

describe("fetchProductChangelog", () => {
  it("asks the latest feed for the releases-sh org and applies the limit", async () => {
    const calls: Array<{ org: string; count: number }> = [];
    const doc = await fetchProductChangelog({
      limit: 1,
      fetchLatest: async (opts) => {
        calls.push(opts);
        return [PLATFORM, CLI];
      },
    });
    expect(calls).toEqual([{ org: "releases-sh", count: 1 }]);
    expect(doc.url).toBe(CHANGELOG_PAGE_URL);
    expect(doc.feed).toBe(CHANGELOG_FEED_URL);
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]?.id).toBe("rel_platform");
  });
});
