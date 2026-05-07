import { describe, it, expect } from "bun:test";
import { sanitizeVersion } from "../../packages/adapters/src/extract/shared";

// LLM-driven extract / agent fetch occasionally emits a literal placeholder
// in the `version` field instead of omitting it. The web frontend promotes
// any non-null version into the heading slot, so a placeholder leaks all the
// way to the UI. The batch insert endpoint at
// `workers/api/src/routes/sources.ts` calls `sanitizeVersion` to drop these
// before they hit the DB — these tests pin the contract that handler relies on.
describe("sanitizeVersion", () => {
  const placeholders = [
    "<UNKNOWN>",
    "<unknown>",
    "UNKNOWN",
    "unknown",
    "<NONE>",
    "none",
    "n/a",
    "N/A",
    "null",
    "undefined",
    "  <unknown>  ",
  ];

  for (const p of placeholders) {
    it(`drops placeholder "${p}"`, () => {
      expect(sanitizeVersion(p)).toBeUndefined();
    });
  }

  it("preserves real version strings", () => {
    expect(sanitizeVersion("v1.2.3")).toBe("v1.2.3");
    expect(sanitizeVersion("2026.04.30")).toBe("2026.04.30");
    expect(sanitizeVersion("Q1-2026")).toBe("Q1-2026");
  });

  it("returns undefined for empty / undefined input", () => {
    expect(sanitizeVersion(undefined)).toBeUndefined();
    expect(sanitizeVersion("")).toBeUndefined();
  });
});
