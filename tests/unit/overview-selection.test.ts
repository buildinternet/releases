import { describe, it, expect } from "bun:test";
import {
  selectReleasesForOverview,
  PER_SOURCE_CAPS,
  PER_KIND_FAMILY_CAPS,
  OVERVIEW_RELEASE_LIMIT,
} from "@buildinternet/releases-core/overview";
import type { Release } from "@buildinternet/releases-core/schema";

function mkReleases(prefix: string, dates: string[]): Release[] {
  return dates.map(
    (d, i) =>
      ({
        id: `rel_${prefix}_${i}`,
        sourceId: `src_${prefix}`,
        publishedAt: d,
      }) as unknown as Release,
  );
}

function mkBatch(prefix: string, n: number, base = "2026-04-01"): Release[] {
  // Descending dates so the cap drops the *oldest* per source as expected.
  return mkReleases(
    prefix,
    Array.from({ length: n }, (_, i) => `${base}T00:0${i}:00.000Z`),
  );
}

describe("selectReleasesForOverview", () => {
  it("applies per-source caps before merging", () => {
    const perSource = [
      { type: "github" as const, releases: mkBatch("github", 30) },
      { type: "scrape" as const, releases: mkBatch("scrape", 30) },
    ];
    const { releases, totalAvailable } = selectReleasesForOverview(perSource, 100);

    expect(totalAvailable).toBe(60);
    // github capped to 10, scrape capped to 20 → 30 selected total
    expect(releases.length).toBe(30);
    expect(releases.filter((r) => r.id.startsWith("rel_github_")).length).toBe(
      PER_SOURCE_CAPS.github,
    );
    expect(releases.filter((r) => r.id.startsWith("rel_scrape_")).length).toBe(
      PER_SOURCE_CAPS.scrape,
    );
  });

  it("sorts merged result by publishedAt desc", () => {
    const perSource = [
      {
        type: "feed" as const,
        releases: mkReleases("feed", ["2026-04-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"]),
      },
      {
        type: "github" as const,
        releases: mkReleases("github", ["2026-04-15T00:00:00.000Z", "2026-02-01T00:00:00.000Z"]),
      },
    ];
    const { releases } = selectReleasesForOverview(perSource);
    const dates = releases.map((r) => r.publishedAt);
    const sorted = dates.toSorted().toReversed();
    expect(dates).toEqual(sorted);
  });

  it("respects the overall limit after capping + sorting", () => {
    const perSource = [{ type: "scrape" as const, releases: mkBatch("scrape", 100) }];
    const { releases } = selectReleasesForOverview(perSource, 5);
    // scrape cap is 20; final limit is 5
    expect(releases.length).toBe(5);
  });

  it("defaults to OVERVIEW_RELEASE_LIMIT when limit omitted", () => {
    const perSource = [
      // 4 sources × 20 cap = 80 capped releases; default limit = 50
      { type: "scrape" as const, releases: mkBatch("a", 30, "2026-04-01") },
      { type: "scrape" as const, releases: mkBatch("b", 30, "2026-03-01") },
      { type: "scrape" as const, releases: mkBatch("c", 30, "2026-02-01") },
      { type: "scrape" as const, releases: mkBatch("d", 30, "2026-01-01") },
    ];
    const { releases } = selectReleasesForOverview(perSource);
    expect(releases.length).toBe(OVERVIEW_RELEASE_LIMIT);
  });

  it("handles empty input", () => {
    const result = selectReleasesForOverview([]);
    expect(result.releases).toEqual([]);
    expect(result.totalAvailable).toBe(0);
  });

  it("handles releases with null publishedAt without throwing", () => {
    const releases = [
      { id: "rel_a", sourceId: "src_x", publishedAt: null },
      { id: "rel_b", sourceId: "src_x", publishedAt: "2026-04-01T00:00:00.000Z" },
    ] as unknown as Release[];
    const { releases: out } = selectReleasesForOverview([{ type: "feed", releases }]);
    expect(out.length).toBe(2);
    // Non-null date sorts ahead of empty string
    expect(out[0].id).toBe("rel_b");
  });

  it("caps the SDK family collectively so non-SDK sources survive", () => {
    // 10 SDK github repos (older) + 1 platform changelog (newest).
    const sdkSources = Array.from({ length: 10 }, (_, i) => ({
      type: "github" as const,
      kind: "sdk" as const,
      releases: mkBatch(`sdk${i}`, 10, "2026-01-01"),
    }));
    const changelog = {
      type: "scrape" as const,
      kind: "platform" as const,
      releases: mkBatch("changelog", 10, "2026-05-01"),
    };
    const { releases } = selectReleasesForOverview([...sdkSources, changelog], 50);

    const sdkCount = releases.filter((r) => r.id.includes("rel_sdk")).length;
    const changelogCount = releases.filter((r) => r.id.startsWith("rel_changelog_")).length;

    // SDK family pooled + capped regardless of how many repos contributed.
    expect(sdkCount).toBe(PER_KIND_FAMILY_CAPS.sdk!);
    // Changelog fully represented (10 <= scrape cap 20), not crowded out.
    expect(changelogCount).toBe(10);
  });

  it("treats null/undefined kind as uncapped (back-compat)", () => {
    const perSource = [
      { type: "github" as const, releases: mkBatch("github", 30) },
      { type: "scrape" as const, releases: mkBatch("scrape", 30) },
    ];
    const { releases } = selectReleasesForOverview(perSource, 100);
    // Identical to the pre-family-cap behavior: 10 (github cap) + 20 (scrape cap).
    expect(releases.length).toBe(30);
  });

  it("does not pad an SDK family that is under its cap", () => {
    const { releases } = selectReleasesForOverview(
      [{ type: "github" as const, kind: "sdk" as const, releases: mkBatch("sdk", 3) }],
      50,
    );
    expect(releases.length).toBe(3);
  });
});
