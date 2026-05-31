import { describe, it, expect } from "bun:test";
import {
  isThinItem,
  isEnrichableUrl,
  assessFeedDepth,
  isBatchAnchorFragment,
  DEFAULT_FEED_THIN_CHARS,
  ANCHOR_FRAGMENT_MAJORITY,
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

  it("returns anchor-fragment instead of summary-only when a majority of thin items use anchored URLs on the same base", () => {
    // CodeRabbit-style: all thin items, all URLs are the same base path with different fragments
    const anchorThin = (fragment: string) =>
      item({
        content: "teaser",
        contentFromSummary: true,
        url: `https://docs.coderabbit.ai/changelog#${fragment}`,
      });
    const batch = [
      anchorThin("suggested-reviewers"),
      anchorThin("rate-limit-visibility"),
      anchorThin("cli-v0-4-4"),
      anchorThin("new-feature"),
      anchorThin("another-entry"),
    ];
    expect(assessFeedDepth(batch, opts)).toBe("anchor-fragment");
  });

  it("returns anchor-fragment even when a minority of items lack anchored URLs", () => {
    const anchorItem = (frag: string) =>
      item({
        content: "teaser",
        contentFromSummary: true,
        url: `https://docs.example.com/changelog#${frag}`,
      });
    const normalItem = item({
      content: "teaser",
      contentFromSummary: true,
      url: "https://blog.example.com/post/1",
    });
    // 4 anchor + 1 non-anchor = 80% anchor => should trigger
    const batch = [anchorItem("a"), anchorItem("b"), anchorItem("c"), anchorItem("d"), normalItem];
    expect(assessFeedDepth(batch, opts)).toBe("anchor-fragment");
  });

  it("returns summary-only (not anchor-fragment) when URLs have fragments but different base paths", () => {
    // URLs share the same host but different paths, so not a single-page anchor changelog
    const diffPathItem = (path: string, frag: string) =>
      item({
        content: "teaser",
        contentFromSummary: true,
        url: `https://docs.example.com/${path}#${frag}`,
      });
    const batch = [
      diffPathItem("blog/post-1", "section"),
      diffPathItem("blog/post-2", "details"),
      diffPathItem("blog/post-3", "info"),
    ];
    // These have fragments but different base paths — should NOT be anchor-fragment
    expect(assessFeedDepth(batch, opts)).toBe("summary-only");
  });

  it("returns null (not anchor-fragment) for batches below minimum size", () => {
    const anchorItem = (frag: string) =>
      item({
        content: "teaser",
        contentFromSummary: true,
        url: `https://docs.example.com/changelog#${frag}`,
      });
    expect(assessFeedDepth([anchorItem("a"), anchorItem("b")], opts)).toBeNull();
  });
});

describe("isBatchAnchorFragment", () => {
  it("returns true for CodeRabbit-style anchor URLs (real fixture from issue #1297)", () => {
    const urls = [
      "https://docs.coderabbit.ai/changelog#suggested-reviewers-on-git-lab",
      "https://docs.coderabbit.ai/changelog#rate-limit-visibility",
      "https://docs.coderabbit.ai/changelog#cli-v0-4-4",
      "https://docs.coderabbit.ai/changelog#new-feature-x",
    ];
    expect(isBatchAnchorFragment(urls)).toBe(true);
  });

  it("returns false when URLs have different base paths even on same host", () => {
    const urls = [
      "https://docs.example.com/blog/post-1",
      "https://docs.example.com/blog/post-2",
      "https://docs.example.com/blog/post-3",
    ];
    expect(isBatchAnchorFragment(urls)).toBe(false);
  });

  it("returns false when URLs have no fragments at all", () => {
    const urls = [
      "https://clerk.com/changelog/2026-05-21-feature-a",
      "https://clerk.com/changelog/2026-05-20-feature-b",
      "https://clerk.com/changelog/2026-05-19-feature-c",
    ];
    expect(isBatchAnchorFragment(urls)).toBe(false);
  });

  it("returns false for an empty or tiny batch", () => {
    expect(isBatchAnchorFragment([])).toBe(false);
    expect(isBatchAnchorFragment(["https://example.com/log#a"])).toBe(false);
  });

  it("returns false when majority anchor fragments point to different base paths", () => {
    const urls = [
      "https://docs.example.com/section-1#anchor",
      "https://docs.example.com/section-2#anchor",
      "https://docs.example.com/section-3#anchor",
    ];
    // Same fragment name, different paths — not a single-page changelog
    expect(isBatchAnchorFragment(urls)).toBe(false);
  });

  it("respects the ANCHOR_FRAGMENT_MAJORITY threshold constant", () => {
    // 2 anchor on same base + 1 completely different → 2/3 = 67% → should
    // return true if ANCHOR_FRAGMENT_MAJORITY <= 0.67
    const urls = [
      "https://docs.example.com/changelog#entry-a",
      "https://docs.example.com/changelog#entry-b",
      "https://other.example.com/blog/post",
    ];
    const result = isBatchAnchorFragment(urls);
    const ratio = 2 / 3;
    expect(result).toBe(ratio >= ANCHOR_FRAGMENT_MAJORITY);
  });
});
