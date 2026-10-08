import { describe, expect, test } from "bun:test";
import type { DigestCoveredRelease } from "@/lib/api";
import {
  buildGlance,
  MAX_GLANCE_TILES,
  OTHERS_KEY,
  releaseImpacts,
  releaseSectionAnchors,
  topReleases,
} from "./digest-glance";

const org = (slug: string) => ({
  slug,
  name: slug.toUpperCase(),
  avatarUrl: null,
  githubHandle: null,
});

function rel(
  id: string,
  product: string | null,
  importance: number | null,
  composition: { features: number; enhancements: number; bugs: number } | null = null,
  orgSlug = product ? `${product}-org` : "solo",
): DigestCoveredRelease {
  return {
    id,
    title: id,
    path: `/release/${id}`,
    url: null,
    org: org(orgSlug),
    product: product ? { slug: product, name: product[0].toUpperCase() + product.slice(1) } : null,
    importance,
    composition,
  };
}

describe("releaseImpacts", () => {
  test("meaningful releases count 2/3/4 scaled by the 0.6 unknown-composition factor", () => {
    const out = releaseImpacts([rel("a", "p", 3), rel("b", "p", 4), rel("c", "p", 5)]);
    expect(out[0]).toBeCloseTo(1.2);
    expect(out[1]).toBeCloseTo(1.8);
    expect(out[2]).toBeCloseTo(2.4);
  });

  test("composition factor weights features 1, enhancements 0.75, fixes 0.5", () => {
    const [allFeatures, allFixes, mixed] = releaseImpacts([
      rel("f", "p", 4, { features: 5, enhancements: 0, bugs: 0 }),
      rel("x", "p", 4, { features: 0, enhancements: 0, bugs: 5 }),
      rel("m", "p", 4, { features: 1, enhancements: 2, bugs: 1 }),
    ]);
    expect(allFeatures).toBeCloseTo(3);
    expect(allFixes).toBeCloseTo(1.5);
    expect(mixed).toBeCloseTo(3 * ((1 + 1.5 + 0.5) / 4));
  });

  test("a product's minor releases share a pool that saturates at 4", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      rel(`m${i}`, "p", 1, { features: 1, enhancements: 0, bugs: 0 }),
    );
    const total = releaseImpacts(many).reduce((a, b) => a + b, 0);
    // sum of bases = 30 → 4·(1−e^(−30/8)) ≈ 3.906
    expect(total).toBeCloseTo(4 * (1 - Math.exp(-30 / 8)));
    expect(total).toBeLessThan(4);
  });

  test("the pool splits back in proportion to base; null importance is minor (0.5)", () => {
    const [nul, one, two] = releaseImpacts([
      rel("n", "p", null),
      rel("o", "p", 1),
      rel("t", "p", 2),
    ]);
    expect(nul).toBeCloseTo(one);
    expect(two).toBeCloseTo(2 * one);
    const sum = 0.6 * (0.5 + 0.5 + 1);
    expect(nul + one + two).toBeCloseTo(4 * (1 - Math.exp(-sum / 8)));
  });

  test("pools are per product", () => {
    const [a, b] = releaseImpacts([rel("a", "p", 1), rel("b", "q", 1)]);
    expect(a).toBeCloseTo(b);
    expect(a).toBeCloseTo(4 * (1 - Math.exp(-0.3 / 8)));
  });
});

describe("buildGlance", () => {
  test("groups by product slug, falling back to org", () => {
    const { products } = buildGlance([
      rel("a", "codex", 5),
      rel("b", "codex", 2),
      rel("c", null, 3, null, "acme"),
    ]);
    expect(products.map((p) => p.key).sort()).toEqual(["codex", "org:acme"]);
    const codex = products.find((p) => p.key === "codex")!;
    expect(codex.name).toBe("Codex");
    expect(codex.releaseCount).toBe(2);
    expect(products.find((p) => p.key === "org:acme")!.name).toBe("ACME");
  });

  test("sorts products by impact and sums composition and flames", () => {
    const { products } = buildGlance([
      rel("a", "small", 1, { features: 0, enhancements: 0, bugs: 3 }),
      rel("b", "big", 4, { features: 2, enhancements: 1, bugs: 0 }),
      rel("c", "big", 5, { features: 1, enhancements: 0, bugs: 4 }),
      rel("d", "big", 2, null),
    ]);
    expect(products.map((p) => p.key)).toEqual(["big", "small"]);
    expect(products[0].composition).toEqual({ features: 3, enhancements: 1, fixes: 4 });
    expect(products[0].hasComposition).toBe(true);
    expect(products[0].flames).toEqual([5, 4]);
    expect(products[1].flames).toEqual([]);
  });

  test("null composition everywhere leaves hasComposition false", () => {
    const { products } = buildGlance([rel("a", "p", 3), rel("b", "p", 1)]);
    expect(products[0].hasComposition).toBe(false);
    expect(products[0].composition).toEqual({ features: 0, enhancements: 0, fixes: 0 });
  });

  test("ranks by importance, then impact; nulls rank as lowest", () => {
    const { ranked } = buildGlance([
      rel("null", "p", null),
      rel("four-fixes", "p", 4, { features: 0, enhancements: 0, bugs: 9 }),
      rel("five", "q", 5),
      rel("four-features", "q", 4, { features: 9, enhancements: 0, bugs: 0 }),
      rel("one", "q", 1),
    ]);
    expect(ranked.map((r) => r.release.id)).toEqual([
      "five",
      "four-features",
      "four-fixes",
      "one",
      "null",
    ]);
  });

  test(`past ${MAX_GLANCE_TILES} products, the smallest fold into Others`, () => {
    const releases = Array.from({ length: 10 }, (_, i) => rel(`r${i}`, `p${i}`, i < 7 ? 5 : 1));
    const { products, ranked } = buildGlance(releases);
    expect(products).toHaveLength(MAX_GLANCE_TILES);
    const others = products.at(-1)!;
    expect(others.key).toBe(OTHERS_KEY);
    expect(others.org).toBeNull();
    expect(others.releaseCount).toBe(3);
    expect(
      ranked
        .filter((r) => r.groupKey === OTHERS_KEY)
        .map((r) => r.release.id)
        .sort(),
    ).toEqual(["r7", "r8", "r9"]);
  });
});

describe("topReleases", () => {
  test("slices the top n, optionally within one group", () => {
    const { ranked } = buildGlance([
      rel("a", "p", 5),
      rel("b", "q", 4),
      rel("c", "p", 3),
      rel("d", "q", 2),
      rel("e", "p", 1),
      rel("f", "q", 1),
    ]);
    expect(topReleases(ranked, null).map((r) => r.release.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(topReleases(ranked, "q").map((r) => r.release.id)).toEqual(["b", "d", "f"]);
  });
});

describe("releaseSectionAnchors", () => {
  test("maps each release to the first section that cites it", () => {
    const anchors = releaseSectionAnchors([
      { anchor: "one", releaseIds: ["a", "b"] },
      { anchor: "two", releaseIds: ["b", "c"] },
    ]);
    expect(Object.fromEntries(anchors)).toEqual({ a: "one", b: "one", c: "two" });
  });
});
