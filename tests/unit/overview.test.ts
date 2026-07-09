import { describe, it, expect } from "bun:test";
import {
  OVERVIEW_STALE_DAYS,
  isOverviewStale,
  isOverviewContentStale,
  overviewAgeDays,
  overviewContentAt,
  overviewContentAgeDays,
  overviewPreview,
  classifyOverviewStaleness,
} from "@buildinternet/releases-core/overview";

const DAY = 24 * 60 * 60 * 1000;

function daysAgoIso(days: number, now: number = Date.now()): string {
  return new Date(now - days * DAY).toISOString();
}

describe("overviewAgeDays", () => {
  it("returns 0 when contentAt is now", () => {
    const now = Date.now();
    expect(overviewAgeDays(new Date(now).toISOString(), now)).toBe(0);
  });

  it("rounds down to whole days", () => {
    const now = Date.now();
    const contentAt = new Date(now - 5 * DAY - 60_000).toISOString();
    expect(overviewAgeDays(contentAt, now)).toBe(5);
  });
});

describe("isOverviewStale", () => {
  it("returns false at exactly the threshold", () => {
    const now = Date.now();
    const contentAt = new Date(now - OVERVIEW_STALE_DAYS * DAY).toISOString();
    expect(isOverviewStale(contentAt, now)).toBe(false);
  });

  it("returns true beyond the threshold", () => {
    const now = Date.now();
    const contentAt = new Date(now - (OVERVIEW_STALE_DAYS + 1) * DAY - 60_000).toISOString();
    expect(isOverviewStale(contentAt, now)).toBe(true);
  });
});

describe("overview content freshness (updatedAt over generatedAt)", () => {
  it("prefers updatedAt as the content write timestamp", () => {
    const now = Date.now();
    const overview = {
      generatedAt: daysAgoIso(90, now),
      updatedAt: daysAgoIso(4, now),
    };
    expect(overviewContentAt(overview)).toBe(overview.updatedAt);
    expect(overviewContentAgeDays(overview, now)).toBe(4);
    expect(isOverviewContentStale(overview, now)).toBe(false);
  });

  it("falls back to generatedAt when updatedAt is missing", () => {
    const now = Date.now();
    const overview = { generatedAt: daysAgoIso(4, now), updatedAt: null };
    expect(overviewContentAt(overview)).toBe(overview.generatedAt);
    expect(isOverviewContentStale(overview, now)).toBe(false);
  });

  it("does not mark amended content stale when only generatedAt is old", () => {
    const now = Date.now();
    // Anthropic-shaped: first write 3 months ago, amend 4 days ago → not stale
    expect(
      isOverviewContentStale(
        {
          generatedAt: daysAgoIso(91, now),
          updatedAt: daysAgoIso(4, now),
        },
        now,
      ),
    ).toBe(false);

    expect(
      isOverviewContentStale(
        {
          generatedAt: daysAgoIso(91, now),
          updatedAt: daysAgoIso(31, now),
        },
        now,
      ),
    ).toBe(true);
  });
});

describe("classifyOverviewStaleness", () => {
  it("returns 'missing' when no overview exists", () => {
    expect(classifyOverviewStaleness(false, 0)).toBe("missing");
    expect(classifyOverviewStaleness(false, 99)).toBe("missing");
  });

  it("returns 'fresh' when an overview exists and no releases since", () => {
    expect(classifyOverviewStaleness(true, 0)).toBe("fresh");
  });

  it("returns 'behind' when releases have shipped since the overview", () => {
    expect(classifyOverviewStaleness(true, 1)).toBe("behind");
    expect(classifyOverviewStaleness(true, 200)).toBe("behind");
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
