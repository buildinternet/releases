import { describe, it, expect } from "bun:test";
import { foldSourcesIntoCatalog, type RawSourceHit } from "../src/api-types";

const src = (over: Partial<RawSourceHit>): RawSourceHit => ({
  slug: "s",
  name: "S",
  type: "github",
  orgSlug: "acme",
  orgName: "Acme",
  productSlug: null,
  ...over,
});

describe("foldSourcesIntoCatalog", () => {
  it("drops a product-member source when its product is already present", () => {
    const result = foldSourcesIntoCatalog(
      [
        {
          slug: "x",
          name: "Product X",
          orgSlug: "acme",
          orgName: "Acme",
          category: null,
          entryType: "product",
        },
      ],
      [src({ slug: "x-feed", name: "X Feed", productSlug: "x", productName: "Product X" })],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ slug: "x", entryType: "product" });
    expect(result.some((r) => r.entryType === "source" && r.sourceSlug === "x-feed")).toBe(false);
  });

  it("promotes a product-member source to a product entry when the product is absent", () => {
    const result = foldSourcesIntoCatalog(
      [],
      [src({ slug: "y-feed", name: "Y Feed", productSlug: "y", productName: "Product Y" })],
    );
    expect(result).toEqual([
      {
        slug: "y",
        name: "Product Y",
        orgSlug: "acme",
        orgName: "Acme",
        category: null,
        entryType: "product",
        kind: undefined,
      },
    ]);
  });

  it("keeps an orphan source (no productSlug) as a source entry", () => {
    const result = foldSourcesIntoCatalog(
      [],
      [src({ slug: "blog", name: "Blog", productSlug: null })],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ slug: "blog", entryType: "source", sourceSlug: "blog" });
  });
});
