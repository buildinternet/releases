import { describe, it, expect } from "bun:test";
import { productPath, sourcePath, sourceOrProductPath } from "./links";

describe("link helpers", () => {
  it("productPath builds an org-scoped product URL", () => {
    expect(productPath("vercel", "nextjs")).toBe("/vercel/product/nextjs");
  });

  it("productPath falls back to the bare product path without an org", () => {
    expect(productPath(null, "nextjs")).toBe("/product/nextjs");
  });

  it("sourcePath builds an org-scoped source URL", () => {
    expect(sourcePath("vercel", "next-js")).toBe("/vercel/next-js");
  });

  it("sourcePath falls back to the global source path without an org", () => {
    expect(sourcePath(null, "next-js")).toBe("/source/next-js");
  });

  it("sourceOrProductPath prefers the product when productSlug is present", () => {
    expect(
      sourceOrProductPath({ orgSlug: "vercel", sourceSlug: "next-js", productSlug: "nextjs" }),
    ).toBe("/vercel/product/nextjs");
  });

  it("sourceOrProductPath falls back to the source when there is no product", () => {
    expect(
      sourceOrProductPath({ orgSlug: "vercel", sourceSlug: "next-js", productSlug: null }),
    ).toBe("/vercel/next-js");
    expect(sourceOrProductPath({ orgSlug: "vercel", sourceSlug: "next-js" })).toBe(
      "/vercel/next-js",
    );
  });
});
