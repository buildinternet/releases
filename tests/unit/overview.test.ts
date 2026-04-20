import { describe, it, expect } from "bun:test";
import {
  OVERVIEW_STALE_DAYS,
  isOverviewStale,
  overviewAgeDays,
  overviewPreview,
} from "@buildinternet/releases-core/overview";

const DAY = 24 * 60 * 60 * 1000;

describe("overviewAgeDays", () => {
  it("returns 0 when generatedAt is now", () => {
    const now = Date.now();
    expect(overviewAgeDays(new Date(now).toISOString(), now)).toBe(0);
  });

  it("rounds down to whole days", () => {
    const now = Date.now();
    const generated = new Date(now - 5 * DAY - 60_000).toISOString();
    expect(overviewAgeDays(generated, now)).toBe(5);
  });
});

describe("isOverviewStale", () => {
  it("returns false at exactly the threshold", () => {
    const now = Date.now();
    const generated = new Date(now - OVERVIEW_STALE_DAYS * DAY).toISOString();
    expect(isOverviewStale(generated, now)).toBe(false);
  });

  it("returns true beyond the threshold", () => {
    const now = Date.now();
    const generated = new Date(now - (OVERVIEW_STALE_DAYS + 1) * DAY - 60_000).toISOString();
    expect(isOverviewStale(generated, now)).toBe(true);
  });
});

describe("overviewPreview", () => {
  it("returns the input untouched when shorter than maxWords", () => {
    expect(overviewPreview("Short single paragraph.", 80)).toBe("Short single paragraph.");
  });

  it("returns the first paragraph when it fits", () => {
    const content = "First paragraph here.\n\nSecond paragraph follows.";
    expect(overviewPreview(content, 80)).toBe("First paragraph here.");
  });

  it("truncates with ellipsis when first paragraph exceeds maxWords", () => {
    const long = "word ".repeat(120).trim();
    const result = overviewPreview(long, 10);
    expect(result.endsWith("…")).toBe(true);
    expect(result.split(/\s+/)).toHaveLength(10);
  });

  it("returns empty string for blank content", () => {
    expect(overviewPreview("   ")).toBe("");
  });

  it("strips a leading markdown heading before previewing", () => {
    const content = "# Some Heading\n\nFirst real paragraph.\n\nSecond paragraph.";
    expect(overviewPreview(content, 80)).toBe("First real paragraph.");
  });
});
