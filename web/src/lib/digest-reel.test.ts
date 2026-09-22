import { describe, expect, test } from "bun:test";
import {
  digestHref,
  sectionProducts,
  sectionProductsFromDetail,
  splitDigestReel,
  toReelPreview,
  CARD_SECTIONS,
  HOVER_RELEASES,
  type ReelDigest,
} from "./digest-reel";

const org = (slug: string) => ({
  slug,
  name: slug.toUpperCase(),
  avatarUrl: null,
  githubHandle: null,
});
const mk = (slug: string, releaseCount: number, isFeatured = false): ReelDigest =>
  ({
    collection: { slug, name: slug, isFeatured },
    weekStart: "2026-09-14",
    title: slug,
    intro: "",
    releaseCount,
    orgs: [],
    sections: [],
  }) as ReelDigest;

describe("splitDigestReel", () => {
  test("featured first, then by release count, capped at cardCount", () => {
    const { cards, more } = splitDigestReel(
      [mk("a", 5), mk("b", 50), mk("c", 9, true), mk("d", 1)],
      2,
    );
    expect(cards.map((d) => d.collection.slug)).toEqual(["c", "b"]);
    expect(more.map((d) => d.collection.slug)).toEqual(["a", "d"]);
  });

  test("ties on release count break by collection name; default cap is 6", () => {
    const input = ["g", "f", "e", "d", "c", "b", "a"].map((s) => mk(s, 3));
    const { cards, more } = splitDigestReel(input);
    expect(cards.map((d) => d.collection.slug)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(more.map((d) => d.collection.slug)).toEqual(["g"]);
  });

  test("does not mutate the input", () => {
    const input = [mk("a", 1), mk("b", 2)];
    splitDigestReel(input);
    expect(input.map((d) => d.collection.slug)).toEqual(["a", "b"]);
  });
});

describe("sectionProducts", () => {
  test("dedupes by product, falls back to org name", () => {
    const section = {
      heading: "h",
      anchor: "h",
      lede: "",
      releases: [
        {
          id: "1",
          title: "",
          url: null,
          path: "/release/1",
          org: org("openai"),
          product: { slug: "codex", name: "Codex" },
        },
        {
          id: "2",
          title: "",
          url: null,
          path: "/release/2",
          org: org("openai"),
          product: { slug: "codex", name: "Codex" },
        },
        { id: "3", title: "", url: null, path: "/release/3", org: org("neon"), product: null },
      ],
    } as ReelDigest["sections"][number];
    expect(sectionProducts(section).map((p) => p.name)).toEqual(["Codex", "NEON"]);
  });
});

describe("sectionProductsFromDetail", () => {
  test("resolves ids through the releases map", () => {
    const byId = new Map([
      [
        "r1",
        {
          id: "r1",
          title: "",
          path: "/release/r1",
          url: null,
          importance: null,
          org: { slug: "openai", name: "OpenAI" },
          product: { slug: "codex", name: "Codex" },
        },
      ],
      [
        "r2",
        {
          id: "r2",
          title: "",
          path: "/release/r2",
          url: null,
          importance: null,
          org: { slug: "cognition", name: "Cognition" },
          product: { slug: "devin", name: "Devin" },
        },
      ],
    ]);
    const out = sectionProductsFromDetail(
      { heading: "h", anchor: "h", lede: "", releaseIds: ["r1", "rX", "r2", "r1"] },
      byId as any,
    );
    expect(out.map((p) => p.name)).toEqual(["Codex", "Devin"]);
  });
});

describe("digestHref", () => {
  test("links the issue, with an optional section anchor", () => {
    const d = mk("coding-agents", 3);
    expect(digestHref(d)).toBe("/collections/coding-agents/digest/2026-09-14");
    expect(digestHref(d, "agents-learn-to-talk")).toBe(
      "/collections/coding-agents/digest/2026-09-14#agents-learn-to-talk",
    );
  });
});

describe("toReelPreview", () => {
  // A digest with more orgs/sections/releases than any card ever renders, so
  // slicing is exercised on every axis at once.
  const bigDigest = (slug: string, releaseCount: number): ReelDigest => {
    const orgs = Array.from({ length: 5 }, (_, i) => org(`${slug}-org${i}`));
    const releaseFor = (o: ReturnType<typeof org>, id: string) => ({
      id,
      title: `Release ${id}`,
      url: null,
      path: `/release/${id}`,
      org: o,
      product: null,
    });
    const sections = Array.from({ length: 5 }, (_, s) => ({
      heading: `Section ${s}`,
      anchor: `section-${s}`,
      lede: `Lede ${s}`,
      // 5 releases across 5 distinct orgs, so `products` dedupes to 5 too —
      // more than HOVER_RELEASES, so slicing and the full-products list
      // diverge and are both independently checkable.
      releases: orgs.map((o, i) => releaseFor(o, `${slug}-s${s}-r${i}`)),
    }));
    return {
      collection: { slug, name: slug, isFeatured: false },
      weekStart: "2026-09-14",
      title: `${slug} digest`,
      intro: `${slug} intro`,
      releaseCount,
      orgs,
      sections,
    } as ReelDigest;
  };

  test("caps cards at splitDigestReel's default (6), the rest land in more", () => {
    const digests = Array.from({ length: 9 }, (_, i) => bigDigest(`c${i}`, 9 - i));
    const preview = toReelPreview(digests);
    expect(preview.totalCount).toBe(9);
    expect(preview.cards.length).toBe(6);
    expect(preview.more.length).toBe(3);
    expect(preview.cards.map((c) => c.collection.slug)).toEqual([
      "c0",
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
    ]);
  });

  test("each card's sections/releases/orgs are sliced to the shared constants", () => {
    const preview = toReelPreview([bigDigest("coding-agents", 25)]);
    const [card] = preview.cards;
    expect(card.sections.length).toBe(CARD_SECTIONS);
    expect(card.orgs.length).toBe(3);
    for (const section of card.sections) {
      expect(section.releases.length).toBe(HOVER_RELEASES);
    }
  });

  test("preserves total counts independent of the sliced arrays", () => {
    const preview = toReelPreview([bigDigest("coding-agents", 25)]);
    const [card] = preview.cards;
    // releaseCount/orgCount are the digest's real totals, not sliced-array
    // lengths — orgs is capped to 3 but there are 5.
    expect(card.releaseCount).toBe(25);
    expect(card.orgCount).toBe(5);
    expect(card.orgs.length).toBe(3);
    for (const section of card.sections) {
      // 5 releases per section, sliced to HOVER_RELEASES (3) below —
      // releaseCount must still read 5.
      expect(section.releaseCount).toBe(5);
    }
  });

  test("section products are the full deduped list, not capped to what's shown", () => {
    const preview = toReelPreview([bigDigest("coding-agents", 25)]);
    const [card] = preview.cards;
    // 5 distinct orgs per section (product: null falls back to org name) —
    // the full list survives even though `releases` is sliced to 3.
    for (const section of card.sections) {
      expect(section.products.length).toBe(5);
    }
  });

  test("more items carry only collection name/slug and weekStart", () => {
    const digests = Array.from({ length: 7 }, (_, i) => bigDigest(`c${i}`, 7 - i));
    const preview = toReelPreview(digests);
    expect(preview.more).toEqual([
      { collection: { slug: "c6", name: "c6" }, weekStart: "2026-09-14" },
    ]);
  });
});
