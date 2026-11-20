import { describe, it, expect } from "bun:test";
import { searchToMarkdown } from "../../src/lib/formatters.js";
import type { UnifiedSearchResponse } from "../../src/api/types.js";

// ── Fixtures ───────────────────────────────────────────────────────

const catalogHits: UnifiedSearchResponse["catalog"] = [
  {
    slug: "react",
    name: "React",
    orgSlug: "meta",
    orgName: "Meta",
    category: "frontend",
    entryType: "product",
  },
  {
    slug: "react-native",
    name: "React Native",
    orgSlug: "meta",
    orgName: "Meta",
    category: null,
    entryType: "source",
    sourceSlug: "react-native",
  },
];

const searchResults: UnifiedSearchResponse = {
  query: "react",
  orgs: [{ slug: "meta", name: "Meta", domain: "meta.com", avatarUrl: null, category: "ai" }],
  catalog: catalogHits,
  products: catalogHits,
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

  it("has Catalog section with product and standalone source details", () => {
    const md = searchToMarkdown(searchResults);
    expect(md).toContain("## Catalog");
    expect(md).toContain("**React**");
    expect(md).toContain("`react`");
    expect(md).toContain("(Meta)");
    expect(md).toContain("**React Native**");
    expect(md).not.toContain("## Sources");
  });

  it("falls back to deprecated `products` alias when `catalog` is absent", () => {
    // Older API deploys send only `products`. Drop this test once the alias
    // is removed from the wire (see monorepo issue #539 follow-up).
    const legacyOnly = {
      query: "react",
      orgs: [],
      products: catalogHits,
      sources: [],
      releases: [],
    } as unknown as UnifiedSearchResponse;
    const md = searchToMarkdown(legacyOnly);
    expect(md).toContain("## Catalog");
    expect(md).toContain("**React**");
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
      catalog: [],
      products: [],
      sources: [],
      releases: [],
    };
    const md = searchToMarkdown(empty);
    expect(md).toContain("No results found.");
    expect(md).not.toContain("## Organizations");
    expect(md).not.toContain("## Catalog");
    expect(md).not.toContain("## Sources");
    expect(md).not.toContain("## Releases");
  });

  it("omits sections that have no results", () => {
    const partial: UnifiedSearchResponse = {
      query: "test",
      orgs: [],
      catalog: [],
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
    expect(md).not.toContain("## Catalog");
    expect(md).not.toContain("## Sources");
    expect(md).toContain("## Releases");
  });
});
