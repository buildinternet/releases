import { describe, it, expect } from "bun:test";
import { ReleasesJsonConfigSchema } from "./well-known.js";

describe("ReleasesJsonConfigSchema", () => {
  it("accepts an empty object (no-op file)", () => {
    expect(ReleasesJsonConfigSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a full org-scope file", () => {
    const r = ReleasesJsonConfigSchema.safeParse({
      $schema: "https://releases.sh/schemas/releases.json",
      name: "Acme",
      description: "CI for teams.",
      category: "developer-tools",
      avatar: "https://acme.com/logo.png",
      tags: ["ci", "observability"],
      social: { twitter: "acmehq", github: "acme" },
      notice: { message: "Docs moved", href: "https://acme.com/docs" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a product-scope file", () => {
    const r = ReleasesJsonConfigSchema.safeParse({
      product: { name: "Acme Cloud", slug: "acme-cloud", category: "cloud", kind: "platform" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-https avatar", () => {
    expect(ReleasesJsonConfigSchema.safeParse({ avatar: "http://acme.com/x.png" }).success).toBe(
      false,
    );
  });

  it("rejects a product with no name", () => {
    expect(ReleasesJsonConfigSchema.safeParse({ product: { slug: "x" } }).success).toBe(false);
  });

  it("rejects an unknown product kind", () => {
    expect(
      ReleasesJsonConfigSchema.safeParse({ product: { name: "Acme Cloud", kind: "saas" } }).success,
    ).toBe(false);
  });

  it("rejects an over-long notice message", () => {
    const r = ReleasesJsonConfigSchema.safeParse({ notice: { message: "x".repeat(281) } });
    expect(r.success).toBe(false);
  });

  it("strips unknown top-level keys", () => {
    const r = ReleasesJsonConfigSchema.parse({ name: "Acme", bogus: 1 });
    expect("bogus" in r).toBe(false);
  });
});
