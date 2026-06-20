import { describe, expect, test } from "bun:test";
import {
  BREAKING_CLASSIFY_KINDS,
  qualifiesForBreakingClassification,
  resolveSourceKind,
  KIND_VALUES,
} from "./kinds";

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
