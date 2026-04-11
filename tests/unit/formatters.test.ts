import { describe, it, expect } from "bun:test";
import {
  sourceToMarkdown,
  orgToMarkdown,
  knowledgeToMarkdown,
  type FormatSourceDetail,
  type FormatOrgDetail,
} from "../../src/lib/formatters.js";
import type { KnowledgePageItem } from "../../src/api/types.js";

// ── Fixtures ───────────────────────────────────────────────────────

const fullSource: FormatSourceDetail = {
  slug: "next-js",
  name: "Next.js",
  type: "github",
  url: "https://github.com/vercel/next.js",
  changelogUrl: "https://nextjs.org/changelog",
  org: { slug: "vercel", name: "Vercel" },
  releaseCount: 150,
  latestVersion: "15.0.0",
  latestDate: "2024-06-15T00:00:00Z",
  lastFetchedAt: "2024-06-16T12:00:00Z",
  trackingSince: "2024-01-01T00:00:00Z",
  releases: [
    {
      version: "15.0.0",
      title: "Next.js 15",
      summary: "Major release with React 19 support",
      content: "Full content here with **markdown**.",
      publishedAt: "2024-06-15T00:00:00Z",
      url: "https://github.com/vercel/next.js/releases/tag/v15.0.0",
    },
    {
      version: "14.2.0",
      title: "14.2.0",
      summary: "Bug fixes",
      publishedAt: "2024-05-01T00:00:00Z",
      url: null,
    },
  ],
  pagination: { page: 1, pageSize: 20, totalPages: 1, totalItems: 2 },
  summaries: {
    rolling: {
      windowDays: 90,
      summary: "Focus on React 19 integration",
      releaseCount: 10,
      generatedAt: "2024-06-16T00:00:00Z",
    },
    monthly: [
      {
        year: 2024,
        month: 6,
        summary: "Major version bump",
        releaseCount: 3,
        generatedAt: "2024-06-16T00:00:00Z",
      },
    ],
  },
};

const fullOrg: FormatOrgDetail = {
  slug: "vercel",
  name: "Vercel",
  domain: "vercel.com",
  avatarUrl: null,
  description: "Frontend cloud platform",
  category: "cloud",
  tags: ["typescript", "edge"],
  aliases: ["vercel.app", "nextjs.org"],
  sourceCount: 5,
  releaseCount: 300,
  releasesLast30Days: 12,
  avgReleasesPerWeek: 3.5,
  lastFetchedAt: "2024-06-16T00:00:00Z",
  trackingSince: "2024-01-01T00:00:00Z",
  accounts: [
    { platform: "github", handle: "vercel" },
    { platform: "twitter", handle: "vercel" },
  ],
  products: [
    {
      id: "prod_1",
      slug: "nextjs",
      name: "Next.js",
      url: "https://nextjs.org",
      description: "React framework",
      sourceCount: 2,
    },
  ],
  sources: [
    {
      slug: "next-js",
      name: "Next.js",
      type: "github",
      releaseCount: 150,
      latestVersion: "15.0.0",
      latestDate: "2024-06-15",
      isPrimary: true,
    },
    {
      slug: "turbo",
      name: "Turborepo",
      type: "github",
      releaseCount: 50,
      latestVersion: "2.0.0",
      latestDate: "2024-06-01",
    },
  ],
};

// ── sourceToMarkdown ───────────────────────────────────────────────

describe("sourceToMarkdown", () => {
  it("contains YAML frontmatter with correct fields", () => {
    const md = sourceToMarkdown(fullSource);
    expect(md).toContain("---");
    expect(md).toContain("name: Next.js");
    expect(md).toContain("slug: next-js");
    expect(md).toContain("type: github");
    expect(md).toContain("source_url: https://github.com/vercel/next.js");
    expect(md).toContain("total_releases: 150");
    expect(md).toContain("tracking_since: 2024-01-01");
  });

  it("contains organization fields when org is present", () => {
    const md = sourceToMarkdown(fullSource);
    expect(md).toContain("organization: Vercel");
    expect(md).toContain("organization_slug: vercel");
  });

  it("contains changelog_url when set", () => {
    const md = sourceToMarkdown(fullSource);
    expect(md).toContain("changelog_url: https://nextjs.org/changelog");
  });

  it("contains latest_version and latest_date when set", () => {
    const md = sourceToMarkdown(fullSource);
    expect(md).toContain("latest_version: 15.0.0");
    expect(md).toContain("latest_date: 2024-06-15");
  });

  it("contains last_updated when lastFetchedAt is set", () => {
    const md = sourceToMarkdown(fullSource);
    expect(md).toContain("last_updated: 2024-06-16");
  });

  it("contains rolling Summary tag with correct attributes", () => {
    const md = sourceToMarkdown(fullSource);
    expect(md).toContain('<Summary type="rolling" window-days="90" release-count="10">');
    expect(md).toContain("Focus on React 19 integration");
    expect(md).toContain("</Summary>");
  });

  it("contains monthly Summary tags with period name", () => {
    const md = sourceToMarkdown(fullSource);
    expect(md).toContain('<Summary type="monthly" period="June 2024"');
    expect(md).toContain('release-count="3"');
    expect(md).toContain("Major version bump");
  });

  it("contains Release tags with version, date, url attributes", () => {
    const md = sourceToMarkdown(fullSource);
    expect(md).toContain('version="15.0.0"');
    expect(md).toContain('date="June 15, 2024"');
    expect(md).toContain('published="2024-06-15T00:00:00Z"');
    expect(md).toContain('url="https://github.com/vercel/next.js/releases/tag/v15.0.0"');
    expect(md).toContain("</Release>");
  });

  it("prefers content over summary in release body", () => {
    const md = sourceToMarkdown(fullSource);
    expect(md).toContain("Full content here with **markdown**.");
    // The summary for the first release should NOT appear since content is present
    const firstReleaseBlock = md.split("</Release>")[0];
    expect(firstReleaseBlock).not.toContain("Major release with React 19 support");
  });

  it("falls back to summary when content is missing", () => {
    const md = sourceToMarkdown(fullSource);
    // The second release has no content, so summary should appear
    const secondReleaseBlock = md.split("</Release>")[1];
    expect(secondReleaseBlock).toContain("Bug fixes");
  });

  it("omits title heading when title equals version", () => {
    const md = sourceToMarkdown(fullSource);
    // "14.2.0" is both version and title — no ## heading
    const secondReleaseBlock = md.split("</Release>")[1];
    expect(secondReleaseBlock).not.toContain("## 14.2.0");
  });

  it("shows title heading when title differs from version", () => {
    const md = sourceToMarkdown(fullSource);
    expect(md).toContain("## Next.js 15");
  });

  it("does NOT show Pagination when totalPages is 1", () => {
    const md = sourceToMarkdown(fullSource);
    expect(md).not.toContain("<Pagination");
  });

  it("shows Pagination tag when totalPages > 1", () => {
    const source: FormatSourceDetail = {
      ...fullSource,
      pagination: { page: 1, pageSize: 20, totalPages: 3, totalItems: 55 },
    };
    const md = sourceToMarkdown(source);
    expect(md).toContain('<Pagination page="1" total-pages="3" total-items="55"');
  });

  it("includes canonical URL when baseUrl is provided", () => {
    const md = sourceToMarkdown(fullSource, { baseUrl: "https://releases.sh" });
    expect(md).toContain("canonical: https://releases.sh/vercel/next-js");
    expect(md).toContain("organization_url: https://releases.sh/vercel");
  });

  it("includes next page URL in Pagination when baseUrl is provided", () => {
    const source: FormatSourceDetail = {
      ...fullSource,
      pagination: { page: 1, pageSize: 20, totalPages: 3, totalItems: 55 },
    };
    const md = sourceToMarkdown(source, { baseUrl: "https://releases.sh" });
    expect(md).toContain('next="https://releases.sh/vercel/next-js.md?page=2"');
  });

  it("omits canonical URL when baseUrl is not provided", () => {
    const md = sourceToMarkdown(fullSource);
    expect(md).not.toContain("canonical:");
    expect(md).not.toContain("organization_url:");
  });

  it("handles null latestVersion, latestDate, lastFetchedAt gracefully", () => {
    const source: FormatSourceDetail = {
      ...fullSource,
      latestVersion: null,
      latestDate: null,
      lastFetchedAt: null,
    };
    const md = sourceToMarkdown(source);
    expect(md).not.toContain("latest_version:");
    expect(md).not.toContain("latest_date:");
    expect(md).not.toContain("last_updated:");
    // Should still produce valid output
    expect(md).toContain("name: Next.js");
  });

  it("handles null org (no organization fields in frontmatter)", () => {
    const source: FormatSourceDetail = {
      ...fullSource,
      org: null,
    };
    const md = sourceToMarkdown(source);
    expect(md).not.toContain("organization:");
    expect(md).not.toContain("organization_slug:");
    // Without org, canonical path uses /source/ prefix
    const mdWithBase = sourceToMarkdown(source, { baseUrl: "https://releases.sh" });
    expect(mdWithBase).toContain("canonical: https://releases.sh/source/next-js");
    expect(mdWithBase).not.toContain("organization_url:");
  });

  it("handles empty releases array", () => {
    const source: FormatSourceDetail = {
      ...fullSource,
      releases: [],
    };
    const md = sourceToMarkdown(source);
    expect(md).not.toContain("<Release");
    expect(md).toContain("name: Next.js");
  });

  it("handles null/empty summaries", () => {
    const source: FormatSourceDetail = {
      ...fullSource,
      summaries: { rolling: null, monthly: [] },
    };
    const md = sourceToMarkdown(source);
    expect(md).not.toContain("<Summary");
    expect(md).toContain("name: Next.js");
  });
});

// ── orgToMarkdown ──────────────────────────────────────────────────

describe("orgToMarkdown", () => {
  it("contains YAML frontmatter with correct fields", () => {
    const md = orgToMarkdown(fullOrg);
    expect(md).toContain("name: Vercel");
    expect(md).toContain("slug: vercel");
    expect(md).toContain("domain: vercel.com");
    expect(md).toContain("sources: 5");
    expect(md).toContain("total_releases: 300");
    expect(md).toContain("releases_last_30d: 12");
    expect(md).toContain("avg_releases_per_week: 3.5");
    expect(md).toContain("last_updated: 2024-06-16");
    expect(md).toContain("tracking_since: 2024-01-01");
  });

  it("contains accounts block with platform/handle", () => {
    const md = orgToMarkdown(fullOrg);
    expect(md).toContain("accounts:");
    expect(md).toContain("  - platform: github");
    expect(md).toContain("    handle: vercel");
    expect(md).toContain("  - platform: twitter");
  });

  it("contains description when set", () => {
    const md = orgToMarkdown(fullOrg);
    expect(md).toContain("description: Frontend cloud platform");
  });

  it("omits description when null", () => {
    const org: FormatOrgDetail = { ...fullOrg, description: null };
    const md = orgToMarkdown(org);
    expect(md).not.toContain("description:");
  });

  it("contains category when set", () => {
    const md = orgToMarkdown(fullOrg);
    expect(md).toContain("category: cloud");
  });

  it("omits category when null", () => {
    const org: FormatOrgDetail = { ...fullOrg, category: null };
    const md = orgToMarkdown(org);
    expect(md).not.toContain("category:");
  });

  it("contains tags list when present", () => {
    const md = orgToMarkdown(fullOrg);
    expect(md).toContain("tags:");
    expect(md).toContain("  - typescript");
    expect(md).toContain("  - edge");
  });

  it("omits tags block when empty", () => {
    const org: FormatOrgDetail = { ...fullOrg, tags: [] };
    const md = orgToMarkdown(org);
    expect(md).not.toContain("tags:");
  });

  it("contains aliases list when present", () => {
    const md = orgToMarkdown(fullOrg);
    expect(md).toContain("aliases:");
    expect(md).toContain("  - vercel.app");
    expect(md).toContain("  - nextjs.org");
  });

  it("omits aliases block when empty", () => {
    const org: FormatOrgDetail = { ...fullOrg, aliases: [] };
    const md = orgToMarkdown(org);
    expect(md).not.toContain("aliases:");
  });

  it("contains Product tags when products are present", () => {
    const md = orgToMarkdown(fullOrg);
    expect(md).toContain('<Product name="Next.js"');
    expect(md).toContain('slug="nextjs"');
    expect(md).toContain('sources="2"');
    expect(md).toContain('url="https://nextjs.org"');
  });

  it("omits Product section when products are empty", () => {
    const org: FormatOrgDetail = { ...fullOrg, products: [] };
    const md = orgToMarkdown(org);
    expect(md).not.toContain("<Product");
  });

  it("omits accounts block when accounts array is empty", () => {
    const org: FormatOrgDetail = { ...fullOrg, accounts: [] };
    const md = orgToMarkdown(org);
    expect(md).not.toContain("accounts:");
  });

  it("contains Source tags with correct attributes", () => {
    const md = orgToMarkdown(fullOrg);
    expect(md).toContain('name="Next.js"');
    expect(md).toContain('slug="next-js"');
    expect(md).toContain('type="github"');
    expect(md).toContain('releases="150"');
    expect(md).toContain('latest-version="15.0.0"');
    expect(md).toContain('latest-date="2024-06-15"');
  });

  it("Source tags include primary=\"true\" for primary sources", () => {
    const md = orgToMarkdown(fullOrg);
    // Next.js is primary
    expect(md).toContain('primary="true"');
    // Turborepo line should NOT have primary
    const turboLine = md.split("\n").find((l) => l.includes('slug="turbo"'));
    expect(turboLine).toBeDefined();
    expect(turboLine).not.toContain("primary");
  });

  it("includes canonical URL and source URLs when baseUrl is provided", () => {
    const md = orgToMarkdown(fullOrg, { baseUrl: "https://releases.sh" });
    expect(md).toContain("canonical: https://releases.sh/vercel");
    expect(md).toContain('url="https://releases.sh/vercel/next-js"');
    expect(md).toContain('url="https://releases.sh/vercel/turbo"');
  });

  it("omits canonical URL when baseUrl is not provided", () => {
    const md = orgToMarkdown(fullOrg);
    expect(md).not.toContain("canonical:");
  });

  it("handles null domain gracefully", () => {
    const org: FormatOrgDetail = { ...fullOrg, domain: null };
    const md = orgToMarkdown(org);
    expect(md).not.toContain("domain:");
    expect(md).toContain("name: Vercel");
  });

  it("handles null lastFetchedAt gracefully", () => {
    const org: FormatOrgDetail = { ...fullOrg, lastFetchedAt: null };
    const md = orgToMarkdown(org);
    expect(md).not.toContain("last_updated:");
    expect(md).toContain("name: Vercel");
  });

  it("handles empty sources array", () => {
    const org: FormatOrgDetail = { ...fullOrg, sources: [] };
    const md = orgToMarkdown(org);
    expect(md).not.toContain("<Source");
    expect(md).toContain("name: Vercel");
  });

  it("includes overview_url when overview exists and baseUrl is provided", () => {
    const org: FormatOrgDetail = {
      ...fullOrg,
      overview: {
        scope: "org",
        content: "test",
        releaseCount: 10,
        lastContributingReleaseAt: "2024-06-15T00:00:00Z",
        generatedAt: "2024-06-16T00:00:00Z",
        updatedAt: "2024-06-16T00:00:00Z",
      },
    };
    const md = orgToMarkdown(org, { baseUrl: "https://releases.sh" });
    expect(md).toContain("overview_url: https://releases.sh/vercel/overview.md");
  });

  it("omits overview_url when overview is absent", () => {
    const md = orgToMarkdown(fullOrg, { baseUrl: "https://releases.sh" });
    expect(md).not.toContain("overview_url:");
  });
});

// ── knowledgeToMarkdown ───────────────────────────────────────────

describe("knowledgeToMarkdown", () => {
  const fullKnowledge: KnowledgePageItem = {
    scope: "org",
    content: "# Overview\n\nThis org ships fast.",
    releaseCount: 42,
    lastContributingReleaseAt: "2024-06-15T00:00:00Z",
    generatedAt: "2024-06-16T00:00:00Z",
    updatedAt: "2024-06-16T00:00:00Z",
  };

  it("contains frontmatter with scope and stats", () => {
    const md = knowledgeToMarkdown(fullKnowledge, { orgSlug: "vercel" });
    expect(md).toContain("scope: org");
    expect(md).toContain("organization: vercel");
    expect(md).toContain("release_count: 42");
    expect(md).toContain("last_release: 2024-06-15");
    expect(md).toContain("generated: 2024-06-16");
  });

  it("includes the content body after frontmatter", () => {
    const md = knowledgeToMarkdown(fullKnowledge);
    expect(md).toContain("# Overview");
    expect(md).toContain("This org ships fast.");
  });

  it("includes canonical URL when baseUrl and orgSlug are provided", () => {
    const md = knowledgeToMarkdown(fullKnowledge, {
      baseUrl: "https://releases.sh",
      orgSlug: "vercel",
    });
    expect(md).toContain("canonical: https://releases.sh/vercel/overview.md");
  });

  it("includes product slug for product-scoped pages", () => {
    const knowledge: KnowledgePageItem = { ...fullKnowledge, scope: "product" };
    const md = knowledgeToMarkdown(knowledge, { productSlug: "nextjs" });
    expect(md).toContain("scope: product");
    expect(md).toContain("product: nextjs");
  });

  it("handles null lastContributingReleaseAt", () => {
    const knowledge: KnowledgePageItem = { ...fullKnowledge, lastContributingReleaseAt: null };
    const md = knowledgeToMarkdown(knowledge);
    expect(md).not.toContain("last_release:");
  });
});
