import { describe, expect, test } from "bun:test";
import { coerceReleaseType } from "./release-type.js";
import { RELEASE_TYPES } from "./schema.js";

describe("coerceReleaseType", () => {
  test("keeps the allowed values and maps everything else to feature", () => {
    for (const type of RELEASE_TYPES) {
      expect(coerceReleaseType(type)).toBe(type);
    }
    expect(coerceReleaseType(undefined)).toBe("feature");
    expect(coerceReleaseType(null)).toBe("feature");
    expect(coerceReleaseType("")).toBe("feature");
    expect(coerceReleaseType("fix")).toBe("feature");
    expect(coerceReleaseType("update")).toBe("feature");
    expect(coerceReleaseType("FEATURE")).toBe("feature");
    expect(coerceReleaseType(1)).toBe("feature");
  });
});
