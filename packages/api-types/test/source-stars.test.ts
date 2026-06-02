import { describe, it, expect } from "bun:test";
import { SourceListItemSchema } from "../src/schemas/sources.js";

const base = {
  slug: "widget",
  name: "widget",
  type: "github" as const,
  releaseCount: 3,
  latestVersion: null,
  latestDate: null,
};

describe("source schemas — stars", () => {
  it("accepts an optional stars field", () => {
    const parsed = SourceListItemSchema.parse({ ...base, stars: 4321 });
    expect(parsed.stars).toBe(4321);
  });

  it("is valid without stars (older responses degrade gracefully)", () => {
    const parsed = SourceListItemSchema.parse(base);
    expect(parsed.stars).toBeUndefined();
  });

  it("accepts an explicit null (fetched row with no value yet)", () => {
    const parsed = SourceListItemSchema.parse({ ...base, stars: null });
    expect(parsed.stars).toBeNull();
  });

  it("rejects a negative star count", () => {
    expect(() => SourceListItemSchema.parse({ ...base, stars: -1 })).toThrow();
  });
});
