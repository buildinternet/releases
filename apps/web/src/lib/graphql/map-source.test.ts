import { describe, expect, it, mock } from "bun:test";
import type { SourceDetail } from "@buildinternet/releases-api-types";

// `server-only` throws outside Next; stub before importing map-source.
mock.module("server-only", () => ({}));

const { mapSourceDetailFromRest } = await import("./map-source");

const baseSource: SourceDetail = {
  id: "src_1",
  slug: "widget-changelog",
  name: "Widget Changelog",
  type: "scrape",
  url: "https://acme.example/changelog",
  orgId: "org_abc",
  productId: "prod_1",
  productSlug: "widget",
  isHidden: false,
  isPrimary: true,
  metadata: "{}",
  org: { id: "org_abc", slug: "acme", name: "Acme" },
  releaseCount: 1,
  releasesLast30Days: 1,
  avgReleasesPerWeek: 0.2,
  latestVersion: "1.0.0",
  latestDate: "2024-06-01",
  lastFetchedAt: "2024-06-02T00:00:00.000Z",
  lastPolledAt: null,
  trackingSince: "2024-01-01T00:00:00.000Z",
  releases: [
    {
      id: "rel_1",
      title: "1.0.0",
      version: "1.0.0",
      summary: "shipped",
      content: "# 1.0.0",
      publishedAt: "2024-06-01T00:00:00.000Z",
      fetchedAt: "2024-06-02T00:00:00.000Z",
      url: "https://acme.example/changelog#1.0.0",
      type: "feature",
      media: [{ type: "image", url: "https://cdn.example/a.png" }],
    },
  ],
  pagination: { nextCursor: null, limit: 20 },
  summaries: { rolling: null, monthly: [] },
};

describe("mapSourceDetailFromRest", () => {
  it("maps identity + release feed into MappedSourceDetail", () => {
    const mapped = mapSourceDetailFromRest(baseSource);
    expect(mapped.id).toBe("src_1");
    expect(mapped.slug).toBe("widget-changelog");
    expect(mapped.org).toEqual({ id: "org_abc", slug: "acme", name: "Acme" });
    expect(mapped.releases).toHaveLength(1);
    expect(mapped.releases[0]).toMatchObject({
      id: "rel_1",
      title: "1.0.0",
      summary: "shipped",
      content: "# 1.0.0",
      type: "feature",
    });
    expect(mapped.pagination).toEqual({ nextCursor: null, limit: 20 });
  });

  it("defaults optional discovery and changelog flags", () => {
    const mapped = mapSourceDetailFromRest(baseSource);
    expect(mapped.discovery).toBe("curated");
    expect(mapped.changelogUrl).toBeNull();
    expect(mapped.hasChangelogFile).toBe(false);
    expect(mapped.notice).toBeNull();
  });
});
