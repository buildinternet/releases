// tests/adapters/scrape-render.test.ts
import { describe, test, expect } from "bun:test";
import { shouldUseFastFetch } from "../../src/lib/render-hint.js";

describe("shouldUseFastFetch", () => {
  test("returns false when renderRequired is true", () => {
    expect(shouldUseFastFetch({ renderRequired: true, provider: "docusaurus" })).toBe(false);
  });

  test("returns true when renderRequired is false", () => {
    expect(shouldUseFastFetch({ renderRequired: false })).toBe(true);
  });

  test("returns true for known static provider", () => {
    expect(shouldUseFastFetch({ provider: "docusaurus" })).toBe(true);
  });

  test("returns true for vitepress", () => {
    expect(shouldUseFastFetch({ provider: "vitepress" })).toBe(true);
  });

  test("returns false for dynamic provider (notion)", () => {
    expect(shouldUseFastFetch({ provider: "notion" })).toBe(false);
  });

  test("returns false when no provider set", () => {
    expect(shouldUseFastFetch({})).toBe(false);
  });

  test("renderRequired true overrides static provider", () => {
    expect(shouldUseFastFetch({ renderRequired: true, provider: "docusaurus" })).toBe(false);
  });

  test("renderRequired false works without provider", () => {
    expect(shouldUseFastFetch({ renderRequired: false, provider: undefined })).toBe(true);
  });
});
