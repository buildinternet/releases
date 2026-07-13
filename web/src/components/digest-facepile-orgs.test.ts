import { describe, expect, test } from "bun:test";
import { orgsFromCoveredReleases } from "./digest-facepile-orgs";
import type { CollectionMember, DigestCoveredRelease } from "@/lib/api";

const release = (slug: string, name: string): DigestCoveredRelease => ({
  id: `rel_${slug}`,
  title: `${name} update`,
  path: `/release/rel_${slug}`,
  org: { slug, name },
});

describe("orgsFromCoveredReleases", () => {
  test("preserves first-appearance order and dedupes", () => {
    const releases = [
      release("vercel", "Vercel"),
      release("cloudflare", "Cloudflare"),
      release("vercel", "Vercel"),
      release("railway", "Railway"),
    ];
    const orgs = orgsFromCoveredReleases(releases, []);
    expect(orgs.map((o) => o.slug)).toEqual(["vercel", "cloudflare", "railway"]);
  });

  test("enriches from collection org members", () => {
    const members: CollectionMember[] = [
      {
        kind: "org",
        slug: "vercel",
        name: "Vercel",
        domain: "vercel.com",
        avatarUrl: "https://example.com/vercel.png",
        githubHandle: "vercel",
        description: null,
      },
    ];
    const orgs = orgsFromCoveredReleases([release("vercel", "Vercel")], members);
    expect(orgs[0]?.avatarUrl).toBe("https://example.com/vercel.png");
    expect(orgs[0]?.githubHandle).toBe("vercel");
  });

  test("falls back to product-member parent org avatars", () => {
    const members: CollectionMember[] = [
      {
        kind: "product",
        slug: "nextjs",
        name: "Next.js",
        description: null,
        org: {
          slug: "vercel",
          name: "Vercel",
          domain: "vercel.com",
          avatarUrl: "https://example.com/v.png",
          githubHandle: "vercel",
        },
      },
    ];
    const orgs = orgsFromCoveredReleases([release("vercel", "Vercel")], members);
    expect(orgs[0]?.avatarUrl).toBe("https://example.com/v.png");
  });
});
