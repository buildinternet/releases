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

/** Overwrite one release's importance in place, returning the same array. */
function withImportance(releases: Release[], index: number, importance: number | null): Release[] {
  (releases[index] as { importance: number | null }).importance = importance;
  return releases;
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

  it("budgets the limit across products so a high-cadence product can't dominate", () => {
    // 3 products, each a single source with 30 releases (capped to 20), plus a
    // direct (no-product) source. Date bases descend so without budgeting the
    // newest product (p1) would take its full 20 and the oldest direct source
    // would be crowded out entirely.
    const perSource = [
      { type: "scrape" as const, productId: "prod_1", releases: mkBatch("p1", 30, "2026-05-01") },
      { type: "scrape" as const, productId: "prod_2", releases: mkBatch("p2", 30, "2026-04-01") },
      { type: "scrape" as const, productId: "prod_3", releases: mkBatch("p3", 30, "2026-03-01") },
      { type: "feed" as const, releases: mkBatch("direct", 30, "2026-02-01") },
    ];
    const { releases } = selectReleasesForOverview(perSource, 50);

    const count = (p: string) => releases.filter((r) => r.id.startsWith(`rel_${p}_`)).length;
    expect(releases.length).toBe(50);
    // 4 buckets, even split of 50 → 12–13 each. No bucket near its 20 cap.
    for (const p of ["p1", "p2", "p3", "direct"]) {
      expect(count(p)).toBeGreaterThanOrEqual(12);
      expect(count(p)).toBeLessThanOrEqual(13);
    }
    // The high-cadence (newest) product is held to a fair share, not 20.
    expect(count("p1")).toBeLessThanOrEqual(13);
    // The oldest direct source survives instead of being crowded out.
    expect(count("direct")).toBeGreaterThanOrEqual(12);
  });

  it("redistributes a small product's unused slots to larger products", () => {
    const perSource = [
      { type: "scrape" as const, productId: "prod_1", releases: mkBatch("p1", 30, "2026-05-01") },
      { type: "scrape" as const, productId: "prod_2", releases: mkBatch("p2", 30, "2026-04-01") },
      // Small product: only 4 releases — below its fair share of ~12.
      {
        type: "scrape" as const,
        productId: "prod_small",
        releases: mkBatch("small", 4, "2026-03-01"),
      },
      { type: "feed" as const, releases: mkBatch("direct", 30, "2026-02-01") },
    ];
    const { releases } = selectReleasesForOverview(perSource, 50);

    const count = (p: string) => releases.filter((r) => r.id.startsWith(`rel_${p}_`)).length;
    expect(releases.length).toBe(50);
    // The small product contributes all 4 of its releases, nothing padded.
    expect(count("small")).toBe(4);
    // Its freed slots flow to the other three, lifting them above the naive
    // even split of 12.
    for (const p of ["p1", "p2", "direct"]) {
      expect(count(p)).toBeGreaterThanOrEqual(13);
    }
  });

  it("pools product-less direct sources into a single bucket", () => {
    // One product (the OLDEST source) competes against TWO newer direct sources.
    // Under pure recency the product would be crowded out (only ~10 of its
    // releases reach the top 50). With one shared no-product bucket there are
    // exactly 2 buckets [product=20-cap, direct=40-pool]: the product's fair
    // share (25) exceeds its capacity so it keeps all 20, and the pooled direct
    // sources take 30. (If each direct source had its own bucket there'd be 3
    // equal buckets and the product would be squeezed to 17.)
    const perSource = [
      { type: "scrape" as const, productId: "prod_1", releases: mkBatch("p1", 30, "2026-02-01") },
      { type: "feed" as const, releases: mkBatch("directA", 30, "2026-05-01") },
      { type: "feed" as const, releases: mkBatch("directB", 30, "2026-04-01") },
    ];
    const { releases } = selectReleasesForOverview(perSource, 50);

    const count = (p: string) => releases.filter((r) => r.id.startsWith(`rel_${p}_`)).length;
    expect(releases.length).toBe(50);
    expect(count("p1")).toBe(20);
    expect(count("directA") + count("directB")).toBe(30);
  });

  describe("importance bias", () => {
    it("retains a high-signal release past the per-source cap over later churn", () => {
      // github cap is 10; give a source 30 releases where the OLDEST (index 29)
      // is the only high-signal one. Pure recency would drop it (kept: newest
      // 10). The importance lead pulls it into the kept set.
      const releases = withImportance(mkBatch("gh", 30), 29, 5);
      const { releases: out } = selectReleasesForOverview(
        [{ type: "github" as const, releases }],
        50,
      );
      expect(out.length).toBe(PER_SOURCE_CAPS.github);
      expect(out.some((r) => r.id === "rel_gh_29")).toBe(true);
    });

    it("retains a high-signal release past the per-kind family cap", () => {
      // SDK family cap is 10. One source's oldest release is high-signal; the
      // family is otherwise all newer churn. It must survive the family pool.
      const sdkA = withImportance(mkBatch("sdkA", 10, "2026-01-01"), 9, 5);
      const sdkB = mkBatch("sdkB", 10, "2026-05-01");
      const { releases: out } = selectReleasesForOverview(
        [
          { type: "github" as const, kind: "sdk" as const, releases: sdkA },
          { type: "github" as const, kind: "sdk" as const, releases: sdkB },
        ],
        50,
      );
      const sdkCount = out.filter((r) => r.id.includes("rel_sdk")).length;
      expect(sdkCount).toBe(PER_KIND_FAMILY_CAPS.sdk!);
      expect(out.some((r) => r.id === "rel_sdkA_9")).toBe(true);
    });

    it("retains a high-signal release past the per-product budget", () => {
      // Two products, each capped to 20, budgeted to ~25 slots → each keeps its
      // full 20. Make one product's OLDEST release (index 19) high-signal and
      // shrink the budget so the bucket must drop some: importance keeps it.
      const p1 = withImportance(mkBatch("p1", 20, "2026-05-01"), 19, 5);
      const p2 = mkBatch("p2", 20, "2026-04-01");
      const { releases: out } = selectReleasesForOverview(
        [
          { type: "scrape" as const, productId: "prod_1", releases: p1 },
          { type: "scrape" as const, productId: "prod_2", releases: p2 },
        ],
        20, // 2 buckets → 10 slots each, so each product drops 10 of its 20.
      );
      expect(out.some((r) => r.id === "rel_p1_19")).toBe(true);
    });

    it("leads the final feed with high-signal releases before recency", () => {
      // A newest churn release and an older high-signal release in one source.
      const releases = withImportance(
        mkReleases("s", ["2026-05-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]),
        1,
        5,
      );
      const { releases: out } = selectReleasesForOverview([{ type: "feed" as const, releases }]);
      // High-signal (older) leads despite the newer churn release.
      expect(out[0].id).toBe("rel_s_1");
      expect(out[1].id).toBe("rel_s_0");
    });

    it("treats NULL importance as unknown, not dead-last", () => {
      // A scored-low release (importance 2) and unscored releases. The unscored
      // rows fold into the same normal bucket ordered by recency — never sorted
      // behind the scored-low one for lacking a score.
      const releases = [
        { id: "rel_x_0", sourceId: "src_x", publishedAt: "2026-05-01T00:00:00.000Z" },
        {
          id: "rel_x_1",
          sourceId: "src_x",
          publishedAt: "2026-04-01T00:00:00.000Z",
          importance: 2,
        },
        { id: "rel_x_2", sourceId: "src_x", publishedAt: "2026-03-01T00:00:00.000Z" },
      ] as unknown as Release[];
      const { releases: out } = selectReleasesForOverview([{ type: "feed" as const, releases }]);
      // Neither high-signal → pure recency; the newest unscored row still leads.
      expect(out.map((r) => r.id)).toEqual(["rel_x_0", "rel_x_1", "rel_x_2"]);
    });
  });
});
