import { describe, it, expect } from "bun:test";
import { searchToMarkdown } from "@releases/rendering/formatters";
import type { SearchCollectionHit, UnifiedSearchResponse } from "@buildinternet/releases-api-types";

/**
 * Targeted coverage for the collections section on `/v1/search` markdown
 * output. Exercises the rendering path end-to-end; the merge ordering itself
 * is unit-tested via the API route's `mergeCollectionHits` helper in
 * `tests/unit/search-collections-merge-helper.test.ts` (this file pairs the
 * two — keep them in sync when the wire shape changes).
 */

function shell(collections: SearchCollectionHit[]): UnifiedSearchResponse {
  return {
    query: "test",
    orgs: [],
    catalog: [],
    sources: [],
    releases: [],
    collections,
  };
}

describe("searchToMarkdown — collections", () => {
  it("omits the Collections heading when the array is empty", () => {
    const md = searchToMarkdown(shell([]));
    expect(md).not.toContain("## Collections");
  });

  it("renders direct hits without a 'includes' hint", () => {
    const md = searchToMarkdown(
      shell([
        {
          slug: "frontier-ai-labs",
          name: "Frontier AI Labs",
          description: "Top frontier model labs.",
          memberCount: 4,
          via: "direct",
        },
      ]),
    );
    expect(md).toContain("## Collections");
    expect(md).toContain("**Frontier AI Labs**");
    expect(md).toContain("4 members");
    expect(md).not.toContain("includes ");
    expect(md).toContain("> Top frontier model labs.");
  });

  it("renders member rollups with the matchedOrgSlugs hint", () => {
    const md = searchToMarkdown(
      shell([
        {
          slug: "frontier-ai-labs",
          name: "Frontier AI Labs",
          description: null,
          memberCount: 4,
          via: "member",
          matchedOrgSlugs: ["anthropic", "openai"],
        },
      ]),
    );
    expect(md).toContain("includes anthropic, openai");
  });

  it("singularizes the member-count label", () => {
    const md = searchToMarkdown(
      shell([
        {
          slug: "solo",
          name: "Solo",
          description: null,
          memberCount: 1,
          via: "direct",
        },
      ]),
    );
    expect(md).toContain("1 member");
    expect(md).not.toContain("1 members");
  });

  it("links the collection to /collections/<slug> when baseUrl is provided", () => {
    const md = searchToMarkdown(
      shell([
        {
          slug: "frontier-ai-labs",
          name: "Frontier AI Labs",
          description: null,
          memberCount: 2,
          via: "direct",
        },
      ]),
      { baseUrl: "https://releases.sh" },
    );
    expect(md).toContain("[view](https://releases.sh/collections/frontier-ai-labs)");
  });

  it("still emits 'No results found' when only collections-shape is empty alongside everything else", () => {
    const md = searchToMarkdown({
      query: "nothing",
      orgs: [],
      catalog: [],
      sources: [],
      releases: [],
      collections: [],
    });
    expect(md).toContain("No results found.");
  });
});
