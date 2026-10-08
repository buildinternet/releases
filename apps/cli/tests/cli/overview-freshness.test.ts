import { describe, it, expect } from "bun:test";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import {
  formatOverviewFreshnessHint,
  formatOverviewFreshnessLine,
  isOverviewContentStale,
  overviewContentAgeDays,
  overviewContentAt,
} from "../../src/lib/overview-freshness.js";

describe("overview freshness line", () => {
  it("keeps the generated-only label when the overview has not been amended", () => {
    const generatedAt = new Date().toISOString();

    const line = formatOverviewFreshnessLine({
      generatedAt,
      updatedAt: generatedAt,
      releaseCount: 10,
    });

    expect(line).toBe("generated just now · 10 releases contributing");
  });

  it("keeps the citation count when freshness details are formatted", () => {
    const generatedAt = new Date().toISOString();

    const line = formatOverviewFreshnessLine({
      generatedAt,
      updatedAt: generatedAt,
      releaseCount: 10,
      citationCount: 2,
    });

    expect(line).toBe("generated just now · 10 releases contributing · 2 citations");
  });

  it("surfaces updated freshness when an amended overview has an older generation time", () => {
    const line = formatOverviewFreshnessLine({
      generatedAt: daysAgoIso(12),
      updatedAt: new Date().toISOString(),
      releaseCount: 10,
    });

    expect(line).toBe("updated just now · generated 12d ago · 10 releases contributing");
  });
});

describe("overview content freshness (updatedAt over generatedAt)", () => {
  it("prefers updatedAt as the content write timestamp", () => {
    const overview = {
      generatedAt: daysAgoIso(90),
      updatedAt: daysAgoIso(4),
    };
    expect(overviewContentAt(overview)).toBe(overview.updatedAt);
    expect(overviewContentAgeDays(overview)).toBe(4);
    expect(isOverviewContentStale(overview)).toBe(false);
  });

  it("falls back to generatedAt when updatedAt is missing", () => {
    const overview = { generatedAt: daysAgoIso(4), updatedAt: null };
    expect(overviewContentAt(overview)).toBe(overview.generatedAt);
    expect(isOverviewContentStale(overview)).toBe(false);
  });

  it("marks stale only when content write is past the threshold", () => {
    // Anthropic-shaped case: first write 3 months ago, amend 4 days ago → not stale
    expect(
      isOverviewContentStale({
        generatedAt: daysAgoIso(91),
        updatedAt: daysAgoIso(4),
      }),
    ).toBe(false);

    // Content last written 31+ days ago → stale
    expect(
      isOverviewContentStale({
        generatedAt: daysAgoIso(91),
        updatedAt: daysAgoIso(31),
      }),
    ).toBe(true);
  });

  it("formats the compact org-get hint with updated when amended", () => {
    const hint = formatOverviewFreshnessHint({
      generatedAt: daysAgoIso(90),
      updatedAt: daysAgoIso(4),
    });
    expect(hint).toBe("updated 4d ago · generated 3mo ago");
  });
});
