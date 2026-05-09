import { describe, it, expect } from "bun:test";
import {
  CATEGORIES,
  categoryDisplayName,
  isValidCategory,
} from "@buildinternet/releases-core/categories";

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

describe("categoryDisplayName", () => {
  it("applies explicit overrides for awkward title-casing", () => {
    expect(categoryDisplayName("ai")).toBe("AI");
    expect(categoryDisplayName("devops")).toBe("DevOps");
  });

  it("title-cases hyphenated slugs", () => {
    expect(categoryDisplayName("developer-tools")).toBe("Developer Tools");
  });

  it("title-cases single-word slugs", () => {
    expect(categoryDisplayName("cloud")).toBe("Cloud");
    expect(categoryDisplayName("database")).toBe("Database");
    expect(categoryDisplayName("infrastructure")).toBe("Infrastructure");
  });

  it("renders every CATEGORIES entry without lowercase residue", () => {
    for (const cat of CATEGORIES) {
      const display = categoryDisplayName(cat);
      expect(display.length).toBeGreaterThan(0);
      // Each whitespace-delimited word should start with an uppercase letter.
      for (const word of display.split(" ")) {
        expect(word[0]).toBe(word[0].toUpperCase());
      }
    }
  });
});
