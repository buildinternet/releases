import { describe, expect, it } from "bun:test";
import {
  ReleasesJsonConfigSchema,
  ReleasesJsonDomainSchema,
  ReleasesJsonRepoSchema,
} from "./well-known.js";

const location = (n: number) => ({ url: `https://acme.com/releases/${n}` });

describe("releases.json v2 schemas", () => {
  it("accepts the minimal domain manifest", () => {
    expect(
      ReleasesJsonDomainSchema.parse({
        version: 2,
        releases: [{ url: "https://acme.com/updates", feed: "https://acme.com/updates.xml" }],
      }),
    ).toEqual({
      version: 2,
      releases: [{ url: "https://acme.com/updates", feed: "https://acme.com/updates.xml" }],
    });
  });

  it("accepts the full domain shape with advisory taxonomy", () => {
    const parsed = ReleasesJsonDomainSchema.parse({
      $schema: "https://releases.sh/schemas/releases.json",
      version: 2,
      name: "Acme",
      description: "CI for teams.",
      category: "future-category",
      avatar: "https://acme.com/logo.png",
      tags: ["future-tag"],
      social: { twitter: "acmehq", github: "acme" },
      products: [
        {
          name: "Acme Cloud",
          slug: "acme-cloud",
          kind: "future-kind",
          category: "future-category",
          description: "Managed CI runners.",
          website: "https://acme.com/cloud",
          docs: "https://docs.acme.com/cloud",
          support: "https://acme.com/support",
          social: { twitter: "acmecloud" },
          tags: ["ci", "cloud"],
          archived: true,
          releases: [{ github: "acme/cloud", canonical: true }],
        },
      ],
      registries: {
        "releases.sh": {
          org: "org_abc123",
          verification: "verification-token",
          futureKey: true,
        },
        "example.com": { anything: "goes" },
      },
    });

    expect(parsed.products?.[0]?.kind).toBe("future-kind");
    expect(parsed.products?.[0]?.tags).toEqual(["ci", "cloud"]);
    expect(parsed.registries?.["example.com"]).toEqual({ anything: "goes" });
  });

  it("accepts product-level tags and enforces the same bounds as org tags", () => {
    expect(
      ReleasesJsonDomainSchema.safeParse({
        version: 2,
        products: [{ name: "Cloud", tags: ["analytics", "sdk"] }],
      }).success,
    ).toBe(true);
    // too many tags (> 50)
    expect(
      ReleasesJsonDomainSchema.safeParse({
        version: 2,
        products: [{ name: "Cloud", tags: Array.from({ length: 51 }, (_, i) => `tag-${i}`) }],
      }).success,
    ).toBe(false);
    // empty tag string
    expect(
      ReleasesJsonDomainSchema.safeParse({
        version: 2,
        products: [{ name: "Cloud", tags: [""] }],
      }).success,
    ).toBe(false);
  });

  it("accepts the repo variant including github self", () => {
    expect(
      ReleasesJsonRepoSchema.safeParse({
        version: 2,
        product: { name: "Acme Cloud", slug: "acme-cloud" },
        releases: [{ github: "self", canonical: true }],
        registries: { "releases.sh": { product: "prd_abc123" } },
      }).success,
    ).toBe(true);
  });

  it("requires the version 2 literal with no v1 compatibility", () => {
    expect(ReleasesJsonConfigSchema.safeParse({ releases: [location(1)] }).success).toBe(false);
    expect(ReleasesJsonConfigSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(ReleasesJsonConfigSchema.safeParse({ version: 3 }).success).toBe(false);
  });

  it("requires at least one locator per release location", () => {
    expect(
      ReleasesJsonDomainSchema.safeParse({ version: 2, releases: [{ title: "Updates" }] }).success,
    ).toBe(false);
  });

  it("allows github self only in repo files", () => {
    expect(
      ReleasesJsonDomainSchema.safeParse({ version: 2, releases: [{ github: "self" }] }).success,
    ).toBe(false);
    expect(
      ReleasesJsonRepoSchema.safeParse({ version: 2, releases: [{ github: "self" }] }).success,
    ).toBe(true);
  });

  it("enforces product and release-location caps", () => {
    expect(
      ReleasesJsonDomainSchema.safeParse({
        version: 2,
        products: Array.from({ length: 25 }, (_, i) => ({ name: `Product ${i}` })),
      }).success,
    ).toBe(false);
    expect(
      ReleasesJsonDomainSchema.safeParse({
        version: 2,
        products: [{ name: "Cloud", releases: Array.from({ length: 9 }, (_, i) => location(i)) }],
      }).success,
    ).toBe(false);
    expect(
      ReleasesJsonDomainSchema.safeParse({
        version: 2,
        releases: Array.from({ length: 33 }, (_, i) => location(i)),
      }).success,
    ).toBe(false);
    expect(
      ReleasesJsonDomainSchema.safeParse({
        version: 2,
        releases: Array.from({ length: 25 }, (_, i) => location(i)),
        products: [
          { name: "Cloud", releases: Array.from({ length: 8 }, (_, i) => location(i + 25)) },
        ],
      }).success,
    ).toBe(false);
  });

  it("allows at most one canonical location per scope", () => {
    const canonical = (n: number) => ({ ...location(n), canonical: true });
    expect(
      ReleasesJsonDomainSchema.safeParse({
        version: 2,
        releases: [canonical(1), canonical(2)],
      }).success,
    ).toBe(false);
    expect(
      ReleasesJsonDomainSchema.safeParse({
        version: 2,
        products: [{ name: "Cloud", releases: [canonical(1), canonical(2)] }],
      }).success,
    ).toBe(false);
  });

  it("rejects removed v1 identity fields", () => {
    expect(
      ReleasesJsonDomainSchema.safeParse({ version: 2, website: "https://acme.com" }).success,
    ).toBe(false);
    expect(
      ReleasesJsonDomainSchema.safeParse({ version: 2, notice: { message: "Moved" } }).success,
    ).toBe(false);
  });

  it("requires typed stable ids for the releases.sh registry", () => {
    expect(
      ReleasesJsonDomainSchema.safeParse({
        version: 2,
        registries: { "releases.sh": { org: "prd_wrong" } },
      }).success,
    ).toBe(false);
    expect(
      ReleasesJsonRepoSchema.safeParse({
        version: 2,
        registries: { "releases.sh": { product: "org_wrong" } },
      }).success,
    ).toBe(false);
  });
});
