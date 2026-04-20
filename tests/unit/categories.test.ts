import { describe, it, expect } from "bun:test";
import { CATEGORIES, isValidCategory } from "@buildinternet/releases-core/categories";

describe("CATEGORIES", () => {
  it("is a non-empty array", () => {
    expect(CATEGORIES.length).toBeGreaterThan(0);
  });

  it("contains known categories", () => {
    expect(CATEGORIES).toContain("ai");
    expect(CATEGORIES).toContain("developer-tools");
    expect(CATEGORIES).toContain("cloud");
  });

  it("all entries are lowercase kebab-case", () => {
    for (const cat of CATEGORIES) {
      expect(cat).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

describe("isValidCategory", () => {
  it("returns true for valid categories", () => {
    expect(isValidCategory("ai")).toBe(true);
    expect(isValidCategory("cloud")).toBe(true);
    expect(isValidCategory("developer-tools")).toBe(true);
  });

  it("returns false for invalid categories", () => {
    expect(isValidCategory("not-a-category")).toBe(false);
    expect(isValidCategory("")).toBe(false);
    expect(isValidCategory("AI")).toBe(false); // case-sensitive
  });
});
