import { describe, it, expect } from "bun:test";
import {
  isThinItem,
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
