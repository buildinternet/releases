import { describe, expect, test } from "bun:test";
import {
  digestHref,
  sectionProducts,
  sectionProductsFromDetail,
  splitDigestReel,
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
