import { describe, it, expect } from "bun:test";
import { catalogHref } from "./catalog-href";

describe("catalogHref", () => {
  it("returns the bare path with no filters", () => {
    expect(catalogHref({})).toBe("/catalog");
    expect(catalogHref({ category: null, includeEmpty: false })).toBe("/catalog");
  });

  it("encodes the category filter", () => {
    expect(catalogHref({ category: "ai" })).toBe("/catalog?category=ai");
  });

  it("encodes the empty toggle", () => {
    expect(catalogHref({ includeEmpty: true })).toBe("/catalog?empty=1");
  });

  it("combines category and empty, category first", () => {
    expect(catalogHref({ category: "developer-tools", includeEmpty: true })).toBe(
      "/catalog?category=developer-tools&empty=1",
    );
  });
});
