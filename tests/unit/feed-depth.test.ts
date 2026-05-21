import { describe, it, expect } from "bun:test";
import {
  isThinItem,
  isEnrichableUrl,
  assessFeedDepth,
  DEFAULT_FEED_THIN_CHARS,
} from "@releases/adapters/feed-depth";
import type { RawRelease } from "@releases/adapters/types";

function item(partial: Partial<RawRelease>): RawRelease {
  return { title: "t", content: "", isBreaking: false, ...partial };
}

const opts = { thinChars: DEFAULT_FEED_THIN_CHARS };

describe("isThinItem", () => {
  it("is thin when content is empty", () => {
    expect(isThinItem(item({ content: "   " }), opts)).toBe(true);
  });
  it("is thin when content fell back to the summary", () => {
    expect(isThinItem(item({ content: "x".repeat(2000), contentFromSummary: true }), opts)).toBe(
      true,
    );
  });
  it("is thin when content is below the char floor", () => {
    expect(isThinItem(item({ content: "short body" }), opts)).toBe(true);
  });
  it("is not thin with a long distinct body", () => {
    expect(isThinItem(item({ content: "x".repeat(2000), contentFromSummary: false }), opts)).toBe(
      false,
    );
  });
});

describe("isEnrichableUrl", () => {
  it("skips an anchored docs section (#fragment) — upstash redis changelog", () => {
    expect(isEnrichableUrl("https://upstash.com/docs/redis/overall/changelog#march-2026")).toBe(
      false,
    );
  });
  it("skips an anchored docs section (#fragment) — upstash vector changelog", () => {
    expect(isEnrichableUrl("https://upstash.com/docs/vector/overall/changelog#august-2025")).toBe(
      false,
    );
  });
  it("skips a filtered-index URL (query on a directory-style path) — figma", () => {
    expect(
      isEnrichableUrl("https://www.figma.com/release-notes/?title=sections-in-figma-slides"),
    ).toBe(false);
  });
  it("skips a root path that carries a query", () => {
    expect(isEnrichableUrl("https://example.com/?p=123")).toBe(false);
  });
  it("enriches a clean changelog permalink — clerk", () => {
    expect(
      isEnrichableUrl("https://clerk.com/changelog/2026-05-21-directory-sync-groups-attributes-ga"),
    ).toBe(true);
  });
  it("enriches a clean blog permalink — neon", () => {
    expect(isEnrichableUrl("https://neon.com/blog/turning-off-fpw-for-faster-writes")).toBe(true);
  });
  it("enriches a clean blog permalink — tailwind", () => {
    expect(isEnrichableUrl("https://tailwindcss.com/blog/tailwindcss-v4-3")).toBe(true);
  });
  it("enriches a permalink that carries tracking params on a non-directory path", () => {
    expect(isEnrichableUrl("https://example.com/blog/post-slug?utm_source=rss")).toBe(true);
  });
  it("enriches a directory-style path when there is no query", () => {
    expect(isEnrichableUrl("https://example.com/blog/")).toBe(true);
  });
  it("treats a bare trailing # as no fragment", () => {
    expect(isEnrichableUrl("https://example.com/blog/post-slug#")).toBe(true);
  });
  it("skips an unparseable or relative URL", () => {
    expect(isEnrichableUrl("/relative/path")).toBe(false);
    expect(isEnrichableUrl("not a url")).toBe(false);
  });
});

describe("assessFeedDepth", () => {
  const thin = item({ content: "teaser", contentFromSummary: true });
  const full = item({ content: "x".repeat(2000), contentFromSummary: false });

  it("returns null below the minimum batch size", () => {
    expect(assessFeedDepth([thin, thin], opts)).toBeNull();
  });
  it("returns summary-only when >=60% are thin", () => {
    expect(assessFeedDepth([thin, thin, full], opts)).toBe("summary-only");
  });
  it("returns full when most items carry bodies", () => {
    expect(assessFeedDepth([full, full, thin], opts)).toBe("full");
  });
  it("returns full when any item has a distinct body and thin ratio is under threshold", () => {
    expect(assessFeedDepth([full, full, full], opts)).toBe("full");
  });
});
