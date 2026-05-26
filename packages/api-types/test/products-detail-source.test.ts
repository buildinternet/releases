import { describe, it, expect } from "bun:test";
import { ProductDetailSourceSchema } from "../src/schemas/products.js";

describe("ProductDetailSourceSchema", () => {
  it("parses without the optional app fields (older responses)", () => {
    const r = ProductDetailSourceSchema.safeParse({
      id: "s",
      slug: "s",
      name: "S",
      type: "scrape",
      url: "https://x",
    });
    expect(r.success).toBe(true);
  });

  it("parses with metadata + kind", () => {
    const r = ProductDetailSourceSchema.safeParse({
      id: "s",
      slug: "s",
      name: "S",
      type: "appstore",
      url: "https://x",
      metadata: JSON.stringify({ appStore: { platform: "ios" } }),
      kind: "mobile",
    });
    expect(r.success).toBe(true);
  });
});
