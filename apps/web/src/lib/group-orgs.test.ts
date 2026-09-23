import { describe, it, expect } from "bun:test";
import type { OrgListItem } from "@/lib/api";
import { groupOrgsByLetter, CATALOG_LETTERS } from "./group-orgs";

/** Minimal OrgListItem factory — only `name`/`slug` matter for grouping. */
function org(name: string, slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-")): OrgListItem {
  return {
    id: `org_${slug}`,
    slug,
    name,
    domain: null,
    description: null,
    category: null,
    avatarUrl: null,
    sourceCount: 0,
    releaseCount: 0,
    recentReleaseCount: 0,
    lastActivity: null,
    topProducts: [],
    sparkline: [], // unused by grouping
  };
}

describe("CATALOG_LETTERS", () => {
  it("is A–Z followed by # (27 entries)", () => {
    expect(CATALOG_LETTERS.length).toBe(27);
    expect(CATALOG_LETTERS[0]).toBe("A");
    expect(CATALOG_LETTERS[25]).toBe("Z");
    expect(CATALOG_LETTERS[26]).toBe("#");
  });
});

describe("groupOrgsByLetter", () => {
  it("returns [] for empty input", () => {
    expect(groupOrgsByLetter([])).toEqual([]);
  });

  it("buckets orgs by the uppercased first letter of the name", () => {
    const groups = groupOrgsByLetter([org("anthropic"), org("Axiom"), org("Cloudflare")]);
    expect(groups.map((g) => g.letter)).toEqual(["A", "C"]);
    expect(groups[0].orgs.map((o) => o.name)).toEqual(["anthropic", "Axiom"]);
    expect(groups[1].orgs.map((o) => o.name)).toEqual(["Cloudflare"]);
  });

  it("sorts within a group case-insensitively by name", () => {
    const groups = groupOrgsByLetter([org("axiom"), org("Apollo"), org("Anthropic")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].orgs.map((o) => o.name)).toEqual(["Anthropic", "Apollo", "axiom"]);
  });

  it("buckets non-alphabetic first chars into '#'", () => {
    const groups = groupOrgsByLetter([org("1Password"), org("@scope/pkg")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].letter).toBe("#");
    expect(groups[0].orgs.map((o) => o.name)).toEqual(["1Password", "@scope/pkg"]);
  });

  it("orders groups A→Z then '#' last, omitting empty letters", () => {
    const groups = groupOrgsByLetter([
      org("Zed"),
      org("1Password"),
      org("GitHub"),
      org("Anthropic"),
    ]);
    expect(groups.map((g) => g.letter)).toEqual(["A", "G", "Z", "#"]);
  });
});
