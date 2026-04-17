import { describe, it, expect } from "bun:test";
import { selectReleasesForOverview } from "../../src/ai/knowledge";
import type { Release, Source } from "@buildinternet/releases-core/schema";

function makeRelease(id: string, publishedAt: string): Release {
  return {
    id,
    sourceId: "src_test",
    version: null,
    type: "feature",
    title: id,
    content: "",
    contentSummary: null,
    url: null,
    contentHash: null,
    metadata: "{}",
    media: "[]",
    publishedAt,
    suppressed: false,
    suppressedReason: null,
    fetchedAt: publishedAt,
    embeddedAt: null,
  };
}

function sortedReleases(prefix: string, count: number, startDay: number): Release[] {
  return Array.from({ length: count }, (_, i) => {
    const day = startDay - i;
    const date = `2026-04-${String(day).padStart(2, "0")}T00:00:00Z`;
    return makeRelease(`${prefix}-${i}`, date);
  });
}

describe("selectReleasesForOverview", () => {
  it("caps high-frequency github sources at 10 releases", () => {
    const perSource: Array<{ type: Source["type"]; releases: Release[] }> = [
      { type: "github", releases: sortedReleases("gh", 50, 30) },
    ];
    const { releases, totalAvailable } = selectReleasesForOverview(perSource, 50);
    expect(releases.length).toBe(10);
    expect(totalAvailable).toBe(50);
  });

  it("gives scrape/feed sources a higher cap than github", () => {
    const perSource: Array<{ type: Source["type"]; releases: Release[] }> = [
      { type: "github", releases: sortedReleases("gh", 30, 30) },
      { type: "scrape", releases: sortedReleases("scr", 30, 30) },
    ];
    const { releases } = selectReleasesForOverview(perSource, 50);
    const ghCount = releases.filter((r) => r.id.startsWith("gh")).length;
    const scrCount = releases.filter((r) => r.id.startsWith("scr")).length;
    expect(ghCount).toBe(10);
    expect(scrCount).toBe(20);
  });

  it("merges by date across sources and clips to limit", () => {
    const perSource: Array<{ type: Source["type"]; releases: Release[] }> = [
      { type: "scrape", releases: sortedReleases("a", 3, 30) }, // days 30, 29, 28
      { type: "scrape", releases: sortedReleases("b", 3, 29) }, // days 29, 28, 27
    ];
    const { releases } = selectReleasesForOverview(perSource, 4);
    expect(releases.length).toBe(4);
    expect(releases[0].publishedAt).toBe("2026-04-30T00:00:00Z");
    expect(releases[3].publishedAt).toBe("2026-04-28T00:00:00Z");
  });

  it("reports totalAvailable across all sources, not just selected", () => {
    const perSource: Array<{ type: Source["type"]; releases: Release[] }> = [
      { type: "github", releases: sortedReleases("a", 100, 30) },
      { type: "scrape", releases: sortedReleases("b", 100, 30) },
    ];
    const { releases, totalAvailable } = selectReleasesForOverview(perSource, 50);
    expect(totalAvailable).toBe(200);
    expect(releases.length).toBeLessThanOrEqual(50);
  });

  it("returns empty when no sources have releases", () => {
    const perSource: Array<{ type: Source["type"]; releases: Release[] }> = [
      { type: "github", releases: [] },
      { type: "scrape", releases: [] },
    ];
    const { releases, totalAvailable } = selectReleasesForOverview(perSource, 50);
    expect(releases).toEqual([]);
    expect(totalAvailable).toBe(0);
  });
});
