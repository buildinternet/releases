import { describe, it, expect } from "bun:test";
import {
  releaseToMarkdown,
  orgReleaseFeedToMarkdown,
  searchToMarkdown,
} from "../../src/lib/formatters.js";
import type { ReleaseDetail, OrgReleaseItem, UnifiedSearchResponse } from "../../src/api/types.js";

// ── Fixtures ───────────────────────────────────────────────────────

const fullRelease: ReleaseDetail = {
  id: "rel_001",
  sourceId: "src_001",
  version: "15.0.0",
  title: "Next.js 15",
  content: "Full content here with **markdown**.",
  contentSummary: "Major release with React 19 support",
  url: "https://github.com/vercel/next.js/releases/tag/v15.0.0",
  media: [],
  publishedAt: "2024-06-15T00:00:00Z",
  fetchedAt: "2024-06-16T12:00:00Z",
  sourceName: "Next.js",
  sourceSlug: "next-js",
  sourceType: "github",
  org: { slug: "vercel", name: "Vercel" },
};

const feedReleases: OrgReleaseItem[] = [
  {
    id: "rel_001",
    version: "15.0.0",
    title: "Next.js 15",
    summary: "Major release",
    content: "Full content for v15.",
    publishedAt: "2024-06-15T00:00:00Z",
    url: "https://example.com/v15",
    source: { slug: "next-js", name: "Next.js", type: "github" },
  },
  {
    id: "rel_002",
    version: "2.0.0",
    title: "Turborepo 2.0",
    summary: "Turbo summary",
    content: "",
    publishedAt: "2024-06-10T00:00:00Z",
    url: null,
    source: { slug: "turbo", name: "Turborepo", type: "github" },
  },
];

const searchResults: UnifiedSearchResponse = {
  query: "react",
  orgs: [{ slug: "meta", name: "Meta", domain: "meta.com", avatarUrl: null, category: "ai" }],
  products: [
    { slug: "react", name: "React", orgSlug: "meta", orgName: "Meta", category: "frontend" },
    {
      slug: "react-native",
      name: "React Native",
      orgSlug: "meta",
      orgName: "Meta",
      category: null,
      kind: "source",
      sourceSlug: "react-native",
    },
  ],
  sources: [],
  releases: [
    {
      id: "rel_react19",
      sourceSlug: "react-releases",
      sourceName: "React Releases",
      orgSlug: "meta",
      version: "19.0.0",
      title: "React 19",
      summary: "Major update with new features",
      publishedAt: "2024-06-01T00:00:00Z",
    },
  ],
};

// ── releaseToMarkdown ─────────────────────────────────────────────

describe("releaseToMarkdown", () => {
  it("contains YAML frontmatter with correct fields", () => {
    const md = releaseToMarkdown(fullRelease);
    expect(md).toContain("---");
    expect(md).toContain("title: Next.js 15");
    expect(md).toContain("version: 15.0.0");
    expect(md).toContain("source: Next.js");
    expect(md).toContain("source_slug: next-js");
    expect(md).toContain("source_type: github");
    expect(md).toContain("published: 2024-06-15");
  });

  it("includes organization fields when org is present", () => {
    const md = releaseToMarkdown(fullRelease);
    expect(md).toContain("organization: Vercel");
    expect(md).toContain("organization_slug: vercel");
  });

  it("omits organization fields when org is null", () => {
    const md = releaseToMarkdown({ ...fullRelease, org: null });
    expect(md).not.toContain("organization:");
    expect(md).not.toContain("organization_slug:");
  });

  it("includes title as heading", () => {
    const md = releaseToMarkdown(fullRelease);
    expect(md).toContain("# Next.js 15");
  });

  it("includes full content body", () => {
    const md = releaseToMarkdown(fullRelease);
    expect(md).toContain("Full content here with **markdown**.");
  });

  it("includes url in frontmatter", () => {
    const md = releaseToMarkdown(fullRelease);
    expect(md).toContain("url: https://github.com/vercel/next.js/releases/tag/v15.0.0");
  });

  it("omits version when null", () => {
    const md = releaseToMarkdown({ ...fullRelease, version: null });
    expect(md).not.toContain("version:");
  });

  it("omits url when null", () => {
    const md = releaseToMarkdown({ ...fullRelease, url: null });
    expect(md).not.toContain("url:");
  });

  it("includes canonical_source when baseUrl is provided", () => {
    const md = releaseToMarkdown(fullRelease, { baseUrl: "https://releases.sh" });
    expect(md).toContain("canonical_source: https://releases.sh/vercel/next-js");
  });

  it("uses /source/ path when org is null", () => {
    const md = releaseToMarkdown({ ...fullRelease, org: null }, { baseUrl: "https://releases.sh" });
    expect(md).toContain("canonical_source: https://releases.sh/source/next-js");
  });

  it("handles empty content gracefully", () => {
    const md = releaseToMarkdown({ ...fullRelease, content: "" });
    expect(md).toContain("# Next.js 15");
    expect(md).toContain("---");
  });
});

// ── orgReleaseFeedToMarkdown ──────────────────────────────────────

describe("orgReleaseFeedToMarkdown", () => {
  it("contains YAML frontmatter with org slug and count", () => {
    const md = orgReleaseFeedToMarkdown("vercel", feedReleases, { nextCursor: null, limit: 20 });
    expect(md).toContain("organization: vercel");
    expect(md).toContain("release_count: 2");
  });

  it("contains Release tags with source attribution", () => {
    const md = orgReleaseFeedToMarkdown("vercel", feedReleases, { nextCursor: null, limit: 20 });
    expect(md).toContain('source="next-js"');
    expect(md).toContain('source="turbo"');
    expect(md).toContain('version="15.0.0"');
    expect(md).toContain('version="2.0.0"');
  });

  it("prefers content over summary", () => {
    const md = orgReleaseFeedToMarkdown("vercel", feedReleases, { nextCursor: null, limit: 20 });
    expect(md).toContain("Full content for v15.");
  });

  it("falls back to summary when content is empty", () => {
    const md = orgReleaseFeedToMarkdown("vercel", feedReleases, { nextCursor: null, limit: 20 });
    expect(md).toContain("Turbo summary");
  });

  it("shows title heading when title differs from version", () => {
    const md = orgReleaseFeedToMarkdown("vercel", feedReleases, { nextCursor: null, limit: 20 });
    expect(md).toContain("## Next.js 15");
    expect(md).toContain("## Turborepo 2.0");
  });

  it("does NOT show Pagination when nextCursor is null", () => {
    const md = orgReleaseFeedToMarkdown("vercel", feedReleases, { nextCursor: null, limit: 20 });
    expect(md).not.toContain("<Pagination");
  });

  it("shows Pagination with cursor when nextCursor is present", () => {
    const cursor = "2024-06-10T00:00:00Z|rel_002";
    const md = orgReleaseFeedToMarkdown("vercel", feedReleases, { nextCursor: cursor, limit: 20 });
    expect(md).toContain("<Pagination");
    expect(md).toContain(`cursor="${cursor}"`);
  });

  it("includes has_more in frontmatter when cursor is present", () => {
    const md = orgReleaseFeedToMarkdown("vercel", feedReleases, {
      nextCursor: "cursor",
      limit: 20,
    });
    expect(md).toContain("has_more: true");
  });

  it("includes next URL in Pagination when baseUrl is provided", () => {
    const cursor = "2024-06-10|rel_002";
    const md = orgReleaseFeedToMarkdown(
      "vercel",
      feedReleases,
      { nextCursor: cursor, limit: 20 },
      { baseUrl: "https://releases.sh" },
    );
    expect(md).toContain('next="https://releases.sh/vercel/releases?cursor=');
  });

  it("handles empty releases array", () => {
    const md = orgReleaseFeedToMarkdown("vercel", [], { nextCursor: null, limit: 20 });
    expect(md).toContain("organization: vercel");
    expect(md).toContain("release_count: 0");
    expect(md).not.toContain("<Release");
  });
});

// ── searchToMarkdown ──────────────────────────────────────────────

describe("searchToMarkdown", () => {
  it("contains query in frontmatter", () => {
    const md = searchToMarkdown(searchResults);
    expect(md).toContain("query: react");
  });

  it("has Organizations section with org details", () => {
    const md = searchToMarkdown(searchResults);
    expect(md).toContain("## Organizations");
    expect(md).toContain("**Meta**");
    expect(md).toContain("`meta`");
    expect(md).toContain("[ai]");
  });

  it("has Products section with product and standalone source details", () => {
    const md = searchToMarkdown(searchResults);
    expect(md).toContain("## Products");
    expect(md).toContain("**React**");
    expect(md).toContain("`react`");
    expect(md).toContain("(Meta)");
    expect(md).toContain("**React Native**");
    expect(md).not.toContain("## Sources");
  });

  it("has Releases section with release details", () => {
    const md = searchToMarkdown(searchResults);
    expect(md).toContain("## Releases");
    expect(md).toContain("**React Releases 19.0.0**");
    expect(md).toContain("React 19");
    expect(md).toContain("2024-06-01");
  });

  it("includes release summary as blockquote", () => {
    const md = searchToMarkdown(searchResults);
    expect(md).toContain("> Major update with new features");
  });

  it("includes view links when baseUrl is provided", () => {
    const md = searchToMarkdown(searchResults, { baseUrl: "https://releases.sh" });
    expect(md).toContain("[view](https://releases.sh/meta)");
    expect(md).toContain("[view](https://releases.sh/meta/product/react)");
    expect(md).toContain("[view](https://releases.sh/meta/react-native)");
  });

  it("shows 'No results found' when all arrays are empty", () => {
    const empty: UnifiedSearchResponse = {
      query: "nothing",
      orgs: [],
      products: [],
      sources: [],
      releases: [],
    };
    const md = searchToMarkdown(empty);
    expect(md).toContain("No results found.");
    expect(md).not.toContain("## Organizations");
    expect(md).not.toContain("## Products");
    expect(md).not.toContain("## Sources");
    expect(md).not.toContain("## Releases");
  });

  it("omits sections that have no results", () => {
    const partial: UnifiedSearchResponse = {
      query: "test",
      orgs: [],
      products: [],
      sources: [],
      releases: [
        {
          id: "rel_foo1",
          sourceSlug: "foo",
          sourceName: "Foo",
          orgSlug: null,
          version: "1.0.0",
          title: "Foo 1.0",
          summary: "First release",
          publishedAt: "2024-01-01T00:00:00Z",
        },
      ],
    };
    const md = searchToMarkdown(partial);
    expect(md).not.toContain("## Organizations");
    expect(md).not.toContain("## Products");
    expect(md).not.toContain("## Sources");
    expect(md).toContain("## Releases");
  });
});
