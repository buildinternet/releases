import { describe, it, expect } from "bun:test";
import { mergeCollectionHits } from "@buildinternet/releases-api-types";
import type { SearchCollectionHit } from "@buildinternet/releases-api-types";

describe("mergeCollectionHits", () => {
  it("does not mutate caller-owned inputs", () => {
    const direct: SearchCollectionHit[] = [
      { slug: "a", name: "A", description: null, memberCount: 2, via: "direct" },
    ];
    const semantic: SearchCollectionHit[] = [
      { slug: "a", name: "A", description: null, memberCount: 2, via: "direct", score: 0.9 },
    ];
    const member: SearchCollectionHit[] = [
      {
        slug: "a",
        name: "A",
        description: null,
        memberCount: 2,
        via: "member",
        matchedOrgSlugs: ["anthropic"],
      },
    ];
    const directSnap = structuredClone(direct);
    const semanticSnap = structuredClone(semantic);
    const memberSnap = structuredClone(member);

    mergeCollectionHits(direct, semantic, member, 10);

    expect(direct).toEqual(directSnap);
    expect(semantic).toEqual(semanticSnap);
    expect(member).toEqual(memberSnap);
  });

  it("attaches matchedOrgSlugs from member to a direct row, keeping via=direct", () => {
    const out = mergeCollectionHits(
      [{ slug: "a", name: "A", description: null, memberCount: 2, via: "direct" }],
      [],
      [
        {
          slug: "a",
          name: "A",
          description: null,
          memberCount: 2,
          via: "member",
          matchedOrgSlugs: ["anthropic"],
        },
      ],
      10,
    );
    expect(out).toHaveLength(1);
    expect(out[0].via).toBe("direct");
    expect(out[0].matchedOrgSlugs).toEqual(["anthropic"]);
  });

  it("upgrades score on a direct row when semantic hits the same slug with a higher score", () => {
    const out = mergeCollectionHits(
      [{ slug: "a", name: "A", description: null, memberCount: 2, via: "direct", score: 0.3 }],
      [{ slug: "a", name: "A", description: null, memberCount: 2, via: "direct", score: 0.9 }],
      [],
      10,
    );
    expect(out[0].score).toBe(0.9);
  });

  it("orders direct before member, then by score desc, then by name", () => {
    const out = mergeCollectionHits(
      [
        { slug: "b", name: "Beta", description: null, memberCount: 1, via: "direct", score: 0.5 },
        { slug: "a", name: "Alpha", description: null, memberCount: 1, via: "direct", score: 0.9 },
      ],
      [],
      [
        {
          slug: "c",
          name: "Gamma",
          description: null,
          memberCount: 1,
          via: "member",
          matchedOrgSlugs: ["x"],
        },
      ],
      10,
    );
    expect(out.map((c) => c.slug)).toEqual(["a", "b", "c"]);
  });
});
