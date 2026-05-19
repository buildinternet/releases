import { describe, expect, test } from "bun:test";
import { KIND_VALUES, isValidKind, resolveSourceKind } from "@buildinternet/releases-core/kinds";

describe("kinds", () => {
  test("KIND_VALUES is the expected fixed list", () => {
    expect(KIND_VALUES).toEqual([
      "platform",
      "sdk",
      "mobile",
      "desktop",
      "docs",
      "integration",
      "tool",
    ]);
  });

  test("isValidKind accepts every enum value", () => {
    for (const v of KIND_VALUES) expect(isValidKind(v)).toBe(true);
  });

  test("isValidKind rejects unknown values", () => {
    expect(isValidKind("framework")).toBe(false);
    expect(isValidKind("")).toBe(false);
    expect(isValidKind("SDK")).toBe(false); // case-sensitive
  });

  test("resolveSourceKind prefers source.kind", () => {
    expect(resolveSourceKind({ kind: "sdk" }, { kind: "platform" })).toBe("sdk");
  });

  test("resolveSourceKind falls back to product.kind when source.kind is null", () => {
    expect(resolveSourceKind({ kind: null }, { kind: "sdk" })).toBe("sdk");
    expect(resolveSourceKind({ kind: undefined }, { kind: "sdk" })).toBe("sdk");
  });

  test("resolveSourceKind returns null when neither is set", () => {
    expect(resolveSourceKind({ kind: null }, { kind: null })).toBe(null);
    expect(resolveSourceKind({ kind: null }, null)).toBe(null);
    expect(resolveSourceKind({ kind: null }, undefined)).toBe(null);
  });
});
