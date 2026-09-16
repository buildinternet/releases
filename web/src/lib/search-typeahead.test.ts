import { describe, expect, it } from "bun:test";
import type { UnifiedSearchResponse } from "./api.ts";
import {
  launcherAction,
  moveHighlight,
  searchPageHref,
  typeaheadItems,
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

describe("launcherAction — header search never navigates on keystroke", () => {
  it("keeps composing on every query change, including the first character", () => {
    expect(launcherAction({ type: "change", query: "m" })).toEqual({
      navigate: false,
      query: "m",
    });
    expect(launcherAction({ type: "change", query: "me" })).toEqual({
      navigate: false,
      query: "me",
    });
    expect(launcherAction({ type: "change", query: "meet" })).toEqual({
      navigate: false,
      query: "meet",
    });
  });

  it("opens the search page on Enter when no hit is highlighted", () => {
    expect(
      launcherAction({ type: "submit", query: "meet", highlight: null, items: [meetOrg] }),
    ).toEqual({ navigate: "/search?q=meet" });
  });

  it("opens the highlighted hit on Enter", () => {
    expect(
      launcherAction({ type: "submit", query: "meet", highlight: 0, items: [meetOrg] }),
    ).toEqual({ navigate: "/google" });
  });

  it("opens a clicked hit", () => {
    expect(launcherAction({ type: "select", item: meetOrg })).toEqual({ navigate: "/google" });
  });

  it("falls back to the search page when the highlight is out of range", () => {
    expect(
      launcherAction({ type: "submit", query: "meet", highlight: 3, items: [meetOrg] }),
    ).toEqual({ navigate: "/search?q=meet" });
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

describe("typeaheadItems", () => {
  it("leads with a Search-all row so Enter defaults to the search page", () => {
    const items = typeaheadItems(null, "meet");
    expect(items).toEqual([
      {
        id: "search-all",
        href: "/search?q=meet",
        label: "Search all results for “meet”",
        kind: "search",
      },
    ]);
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
});
