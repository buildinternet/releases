import { describe, it, expect } from "bun:test";
import {
  CATEGORIES,
  CATEGORY_ALIAS_RE,
  categoryDisplayName,
  isValidCategory,
  parseCategoryAliases,
  resolveCategorySlug,
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

describe("parseCategoryAliases", () => {
  it("returns an empty array for null/undefined/empty input", () => {
    expect(parseCategoryAliases(null)).toEqual([]);
    expect(parseCategoryAliases(undefined)).toEqual([]);
    expect(parseCategoryAliases("")).toEqual([]);
  });

  it("parses a JSON string array", () => {
    expect(parseCategoryAliases('["e-commerce","ecommerce"]')).toEqual(["e-commerce", "ecommerce"]);
  });

  it("filters non-string entries", () => {
    expect(parseCategoryAliases('["a",1,null,"b"]')).toEqual(["a", "b"]);
  });

  it("degrades to [] on malformed JSON or non-array payloads", () => {
    expect(parseCategoryAliases("not json")).toEqual([]);
    expect(parseCategoryAliases('{"a":1}')).toEqual([]);
  });
});

describe("resolveCategorySlug", () => {
  const aliasMap = new Map<string, string>([
    ["e-commerce", "commerce"],
    ["ecommerce", "commerce"],
  ]);

  it("returns canonical slugs unchanged", () => {
    expect(resolveCategorySlug("ai", aliasMap)).toBe("ai");
    expect(resolveCategorySlug("commerce", aliasMap)).toBe("commerce");
  });

  it("resolves aliases to canonical", () => {
    expect(resolveCategorySlug("e-commerce", aliasMap)).toBe("commerce");
    expect(resolveCategorySlug("ecommerce", aliasMap)).toBe("commerce");
  });

  it("returns null for unknown input", () => {
    expect(resolveCategorySlug("not-real", aliasMap)).toBeNull();
    expect(resolveCategorySlug("", aliasMap)).toBeNull();
  });

  it("ignores alias map entries that don't point to a canonical slug", () => {
    const bogus = new Map([["foo", "bar"]]);
    expect(resolveCategorySlug("foo", bogus)).toBeNull();
  });
});

describe("CATEGORY_ALIAS_RE", () => {
  it("accepts kebab-case slugs", () => {
    expect(CATEGORY_ALIAS_RE.test("e-commerce")).toBe(true);
    expect(CATEGORY_ALIAS_RE.test("dev-tools")).toBe(true);
    expect(CATEGORY_ALIAS_RE.test("ai")).toBe(true);
  });

  it("rejects uppercase, leading hyphen, or whitespace", () => {
    expect(CATEGORY_ALIAS_RE.test("E-Commerce")).toBe(false);
    expect(CATEGORY_ALIAS_RE.test("-leading")).toBe(false);
    expect(CATEGORY_ALIAS_RE.test("has space")).toBe(false);
    expect(CATEGORY_ALIAS_RE.test("")).toBe(false);
  });
});
