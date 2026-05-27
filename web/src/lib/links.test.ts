import { describe, it, expect } from "bun:test";
import { productPath, sourcePath, sourceOrProductPath, sourceIdPath } from "./links";

describe("link helpers", () => {
  it("productPath builds a bare org-scoped product URL", () => {
    expect(productPath("vercel", "next-js")).toBe("/vercel/next-js");
  });

  it("productPath falls back to the bare product path without an org", () => {
    expect(productPath(null, "next-js")).toBe("/product/next-js");
  });

  it("sourcePath builds an org-scoped source URL", () => {
    expect(sourcePath("vercel", "next-js")).toBe("/vercel/next-js");
  });

  it("sourcePath falls back to the global source path without an org", () => {
    expect(sourcePath(null, "next-js")).toBe("/source/next-js");
  });

  it("sourceOrProductPath prefers the product when productSlug is present", () => {
    expect(
      sourceOrProductPath({ orgSlug: "vercel", sourceSlug: "next-js", productSlug: "next-js" }),
    ).toBe("/vercel/next-js");
  });

  it("sourceOrProductPath falls back to the source when there is no product", () => {
    expect(
      sourceOrProductPath({ orgSlug: "vercel", sourceSlug: "vercel-docs", productSlug: null }),
    ).toBe("/vercel/vercel-docs");
    expect(sourceOrProductPath({ orgSlug: "vercel", sourceSlug: "vercel-docs" })).toBe(
      "/vercel/vercel-docs",
    );
  });

  describe("sourceIdPath", () => {
    it("builds a sources/:id URL", () => {
      expect(sourceIdPath("src_abc123")).toBe("/sources/src_abc123");
    });
  });
});
