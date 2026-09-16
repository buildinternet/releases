import { describe, expect, it } from "bun:test";
import type { UnifiedSearchResponse } from "./api.ts";
import {
  KIND_LABEL,
  launcherAction,
  moveHighlight,
  resultsMatchQuery,
  searchPageHref,
  typeaheadItems,
  typeaheadStatus,
  type TypeaheadItem,
} from "./search-typeahead.ts";

function results(overrides: Partial<UnifiedSearchResponse> = {}): UnifiedSearchResponse {
  return {
    query: "meet",
    orgs: [],
    catalog: [],
    sources: [],
    releases: [],
    ...overrides,
  };
}

const meetOrg: TypeaheadItem = {
  id: "org:google",
  href: "/google",
  label: "Google",
  kind: "org",
};

const searchAll: TypeaheadItem = {
  id: "search-all",
  href: "/search?q=meet",
  label: "Search all results for “meet”",
  kind: "search",
};

describe("launcherAction — header search never navigates on keystroke", () => {
  it("keeps composing on every query change, including the first character", () => {
    expect(launcherAction({ type: "change", query: "m" })).toEqual({
      kind: "compose",
      query: "m",
    });
    expect(launcherAction({ type: "change", query: "me" })).toEqual({
      kind: "compose",
      query: "me",
    });
    expect(launcherAction({ type: "change", query: "meet" })).toEqual({
      kind: "compose",
      query: "meet",
    });
  });

  it("opens the search page on Enter when no hit is highlighted", () => {
    expect(
      launcherAction({ type: "submit", query: "meet", highlight: null, items: [meetOrg] }),
    ).toEqual({ kind: "go", href: "/search?q=meet" });
  });

  it("opens the highlighted hit on Enter", () => {
    expect(
      launcherAction({ type: "submit", query: "meet", highlight: 0, items: [meetOrg] }),
    ).toEqual({ kind: "go", href: "/google" });
  });

  it("opens a clicked hit", () => {
    expect(launcherAction({ type: "select", item: meetOrg })).toEqual({
      kind: "go",
      href: "/google",
    });
  });

  it("falls back to the search page when the highlight is out of range", () => {
    expect(
      launcherAction({ type: "submit", query: "meet", highlight: 3, items: [meetOrg] }),
    ).toEqual({ kind: "go", href: "/search?q=meet" });
  });
});

describe("searchPageHref", () => {
  it("encodes the query and omits q when empty", () => {
    expect(searchPageHref("meet")).toBe("/search?q=meet");
    expect(searchPageHref("  vercel cli  ")).toBe("/search?q=vercel%20cli");
    expect(searchPageHref("   ")).toBe("/search");
  });
});

describe("moveHighlight", () => {
  it("starts at the first or last item from an empty highlight", () => {
    expect(moveHighlight(null, 1, 3)).toBe(0);
    expect(moveHighlight(null, -1, 3)).toBe(2);
  });

  it("clears the highlight when stepping off either end (Enter → full search)", () => {
    expect(moveHighlight(0, -1, 3)).toBeNull();
    expect(moveHighlight(2, 1, 3)).toBeNull();
  });

  it("moves within the list", () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(1, -1, 3)).toBe(0);
  });
});

describe("resultsMatchQuery", () => {
  it("rejects hits from a previous unrelated query", () => {
    expect(resultsMatchQuery(results({ query: "api" }), "meet")).toBe(false);
  });

  it("keeps prefix hits while the user is still typing", () => {
    expect(resultsMatchQuery(results({ query: "me" }), "meet")).toBe(true);
    expect(resultsMatchQuery(results({ query: "meet" }), "meet")).toBe(true);
  });

  it("rejects hits for a longer query after a backspace", () => {
    expect(resultsMatchQuery(results({ query: "meet" }), "me")).toBe(false);
  });
});

describe("typeaheadStatus", () => {
  it("is idle for an empty query", () => {
    expect(typeaheadStatus({ query: "  ", loading: false, items: [] })).toBe("idle");
  });

  it("is loading when the fetch is in flight and there are no entity hits", () => {
    expect(typeaheadStatus({ query: "meet", loading: true, items: [searchAll] })).toBe("loading");
  });

  it("is empty when the fetch finished with only the search-all row", () => {
    expect(typeaheadStatus({ query: "meet", loading: false, items: [searchAll] })).toBe("empty");
  });

  it("is results when there is an entity hit", () => {
    expect(typeaheadStatus({ query: "meet", loading: false, items: [searchAll, meetOrg] })).toBe(
      "results",
    );
  });

  it("prefers results over loading when prefix hits are already showing", () => {
    expect(typeaheadStatus({ query: "meet", loading: true, items: [searchAll, meetOrg] })).toBe(
      "results",
    );
  });
});

describe("typeaheadItems", () => {
  it("leads with a Search-all row so Enter defaults to the search page", () => {
    const items = typeaheadItems(null, "meet");
    expect(items).toEqual([searchAll]);
  });

  it("returns no rows for an empty query", () => {
    expect(typeaheadItems(null, "  ")).toEqual([]);
  });

  it("caps each section and maps hrefs", () => {
    const items = typeaheadItems(
      results({
        orgs: [
          { slug: "google", name: "Google", domain: "google.com", avatarUrl: null, category: null },
          { slug: "meet-co", name: "Meet Co", domain: null, avatarUrl: null, category: null },
          { slug: "a", name: "A", domain: null, avatarUrl: null, category: null },
          { slug: "b", name: "B", domain: null, avatarUrl: null, category: null },
        ],
        catalog: [
          {
            slug: "meet",
            name: "Google Meet",
            orgSlug: "google",
            orgName: "Google",
            category: null,
            entryType: "product",
          },
        ],
        collections: [
          {
            slug: "comms",
            name: "Comms",
            description: null,
            memberCount: 4,
            via: "direct",
          },
        ],
        releases: [
          {
            id: "rel_1",
            sourceSlug: "notes",
            sourceName: "Developer Release Notes",
            orgSlug: "google",
            version: null,
            title: "Google Meet announcement",
            summary: "",
            publishedAt: "2026-04-02T00:00:00Z",
            importance: null,
          },
        ],
      }),
      "meet",
    );

    expect(items[0]?.kind).toBe("search");
    expect(items.filter((i) => i.kind === "org")).toHaveLength(3);
    expect(items).toContainEqual({
      id: "product:google:meet",
      href: "/google/meet",
      label: "Google Meet",
      secondary: "Google",
      kind: "product",
    });
    expect(items).toContainEqual({
      id: "collection:comms",
      href: "/collections/comms",
      label: "Comms",
      secondary: "4 members",
      kind: "collection",
    });
    expect(items).toContainEqual({
      id: "release:rel_1",
      href: "/release/rel_1",
      label: "Google Meet announcement",
      secondary: "Developer Release Notes",
      kind: "release",
    });
  });

  it("labels catalog sources as source, not product", () => {
    const items = typeaheadItems(
      results({
        query: "notes",
        catalog: [
          {
            slug: "notes",
            name: "Developer Notes",
            orgSlug: "google",
            orgName: "Google",
            category: null,
            entryType: "source",
            sourceSlug: "notes",
          },
        ],
      }),
      "notes",
    );

    expect(items).toContainEqual({
      id: "source:google:notes",
      href: "/google/notes",
      label: "Developer Notes",
      secondary: "Google",
      kind: "source",
    });
    expect(KIND_LABEL.source).toBe("Source");
    expect(KIND_LABEL.product).toBe("Product");
  });
});
