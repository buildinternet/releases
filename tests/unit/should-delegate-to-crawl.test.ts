import { describe, it, expect } from "bun:test";
import type { Source } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types";
import type { SourceMetadata } from "@releases/adapters/feed";
import { shouldDelegateToCrawl } from "../../workers/api/src/cron/poll-fetch.js";

/**
 * The decision function gates the new "summary-only feed → discovery crawl"
 * delegation introduced for sources like Notion's releases page, whose RSS
 * feed carries titles + links but no body. Cheap pure-function checks here;
 * the round-trip to discovery is covered separately by integration tests.
 */

function makeSource(overrides?: Partial<Source>): Source {
  return {
    id: "src_test",
    slug: "test",
    name: "Test",
    type: "scrape",
    url: "https://example.com/changelog",
    orgId: "org_test",
    productId: null,
    metadata: null,
    isPrimary: false,
    isHidden: false,
    discovery: "curated",
    fetchPriority: "normal",
    consecutiveErrors: 0,
    consecutiveNoChange: 0,
    nextFetchAfter: null,
    lastFetchedAt: null,
    lastPolledAt: null,
    lastContentHash: null,
    changeDetectedAt: null,
    trackingSince: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as Source;
}

function makeRaw(content: string, url = "https://example.com/r/1"): RawRelease {
  return { title: "Some release", content, url } as unknown as RawRelease;
}

describe("shouldDelegateToCrawl", () => {
  const items = [makeRaw(""), makeRaw("")];

  it("delegates when feedContentDepth is summary-only AND crawl is enabled", () => {
    expect(
      shouldDelegateToCrawl(
        makeSource(),
        { feedContentDepth: "summary-only", crawlEnabled: true } as SourceMetadata,
        items,
      ),
    ).toBe(true);
  });

  it("delegates when every item has empty content AND crawl is enabled", () => {
    expect(
      shouldDelegateToCrawl(makeSource(), { crawlEnabled: true } as SourceMetadata, items),
    ).toBe(true);
  });

  it("treats whitespace-only content as empty", () => {
    expect(
      shouldDelegateToCrawl(makeSource(), { crawlEnabled: true } as SourceMetadata, [
        makeRaw("   "),
        makeRaw("\n\n"),
      ]),
    ).toBe(true);
  });

  it("does NOT delegate when crawl is not enabled even if feed is summary-only", () => {
    expect(
      shouldDelegateToCrawl(
        makeSource(),
        { feedContentDepth: "summary-only" } as SourceMetadata,
        items,
      ),
    ).toBe(false);
  });

  it("does NOT delegate when any item has real content", () => {
    expect(
      shouldDelegateToCrawl(makeSource(), { crawlEnabled: true } as SourceMetadata, [
        makeRaw(""),
        makeRaw("# A real changelog body\n\nWith stuff."),
      ]),
    ).toBe(false);
  });

  it("does NOT delegate for non-scrape sources (agent/github/feed have their own paths)", () => {
    for (const type of ["feed", "github", "agent"] as const) {
      expect(
        shouldDelegateToCrawl(
          makeSource({ type }),
          { feedContentDepth: "summary-only", crawlEnabled: true } as SourceMetadata,
          items,
        ),
      ).toBe(false);
    }
  });

  it("does NOT delegate when the feed returned zero items (no change to enrich)", () => {
    expect(
      shouldDelegateToCrawl(
        makeSource(),
        { feedContentDepth: "summary-only", crawlEnabled: true } as SourceMetadata,
        [],
      ),
    ).toBe(false);
  });
});
