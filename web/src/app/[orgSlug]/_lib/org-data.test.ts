import { describe, expect, it } from "bun:test";
import type { OrgDetail } from "@buildinternet/releases-api-types";
import { mapOrgPageFromRest } from "./org-data";

const baseOrg: OrgDetail = {
  id: "org_abc",
  slug: "acme",
  name: "Acme",
  domain: "acme.example",
  avatarUrl: null,
  sourceCount: 1,
  releaseCount: 2,
  releasesLast30Days: 1,
  avgReleasesPerWeek: 0.5,
  lastFetchedAt: null,
  lastPolledAt: null,
  trackingSince: "2024-01-01T00:00:00.000Z",
  accounts: [{ platform: "github", handle: "acme" }],
  products: [
    {
      id: "prod_1",
      slug: "widget",
      name: "Widget",
      url: null,
      description: null,
      sourceCount: 1,
      kind: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      releaseCount: 2,
    },
  ],
  sources: [
    {
      id: "src_1",
      slug: "widget-changelog",
      name: "Widget Changelog",
      type: "scrape",
      url: "https://acme.example/changelog",
      releaseCount: 2,
      latestVersion: "1.0.0",
      latestDate: "2024-06-01",
      metadata: "{}",
    },
  ],
};

describe("mapOrgPageFromRest", () => {
  it("maps identity, products, and sources", () => {
    const page = mapOrgPageFromRest(baseOrg);
    expect(page.id).toBe("org_abc");
    expect(page.slug).toBe("acme");
    expect(page.products).toEqual([
      {
        id: "prod_1",
        slug: "widget",
        name: "Widget",
        url: null,
        description: null,
        sourceCount: 1,
        kind: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        releaseCount: 2,
      },
    ]);
    expect(page.sources).toHaveLength(1);
    expect(page.sources[0]?.slug).toBe("widget-changelog");
  });

  it("fills GraphQL-required defaults when REST omits optional flags", () => {
    const page = mapOrgPageFromRest(baseOrg);
    expect(page.isHidden).toBe(false);
    expect(page.discovery).toBe("curated");
    expect(page.status).toBe("tracked");
    expect(page.tags).toEqual([]);
    expect(page.aliases).toEqual([]);
    expect(page.description).toBeNull();
    expect(page.category).toBeNull();
  });
});
