import { describe, expect, test } from "bun:test";
import {
  BREAKING_CLASSIFY_KINDS,
  qualifiesForBreakingClassification,
  resolveSourceKind,
  KIND_VALUES,
  isValidKind,
} from "./kinds";

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

describe("qualifiesForBreakingClassification", () => {
  test("developer-facing kinds qualify", () => {
    for (const kind of BREAKING_CLASSIFY_KINDS) {
      expect(qualifiesForBreakingClassification(kind)).toBe(true);
    }
    expect(qualifiesForBreakingClassification("sdk")).toBe(true);
    expect(qualifiesForBreakingClassification("tool")).toBe(true);
    expect(qualifiesForBreakingClassification("platform")).toBe(true);
    expect(qualifiesForBreakingClassification("integration")).toBe(true);
  });

  test("consumer / docs / kind-less rows do NOT qualify (fail-open to unknown)", () => {
    expect(qualifiesForBreakingClassification("mobile")).toBe(false);
    expect(qualifiesForBreakingClassification("docs")).toBe(false);
    expect(qualifiesForBreakingClassification("desktop")).toBe(false);
    expect(qualifiesForBreakingClassification(null)).toBe(false);
  });

  test("the qualifying set is a subset of the canonical kinds", () => {
    for (const kind of BREAKING_CLASSIFY_KINDS) {
      expect(KIND_VALUES as readonly string[]).toContain(kind);
    }
  });

  test("composes with resolveSourceKind (source wins, else parent product)", () => {
    // source.kind wins
    expect(
      qualifiesForBreakingClassification(resolveSourceKind({ kind: "sdk" }, { kind: "docs" })),
    ).toBe(true);
    // inherits parent product kind when source kind is null
    expect(
      qualifiesForBreakingClassification(resolveSourceKind({ kind: null }, { kind: "tool" })),
    ).toBe(true);
    // neither set → null → does not qualify
    expect(qualifiesForBreakingClassification(resolveSourceKind({ kind: null }, null))).toBe(false);
    // both consumer-side → does not qualify
    expect(
      qualifiesForBreakingClassification(resolveSourceKind({ kind: "mobile" }, { kind: "docs" })),
    ).toBe(false);
  });
});
