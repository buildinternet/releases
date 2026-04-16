import { describe, test, expect } from "bun:test";

// We can't import the module directly without side-effecting getDataDir,
// so we test the pure logic by extracting it inline.

function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map(Number);
}

function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] ?? 0;
    const cv = c[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

describe("update-check", () => {
  describe("isNewer", () => {
    test("patch bump detected", () => {
      expect(isNewer("0.11.2", "0.11.1")).toBe(true);
    });

    test("minor bump detected", () => {
      expect(isNewer("0.12.0", "0.11.1")).toBe(true);
    });

    test("major bump detected", () => {
      expect(isNewer("1.0.0", "0.11.1")).toBe(true);
    });

    test("same version is not newer", () => {
      expect(isNewer("0.11.1", "0.11.1")).toBe(false);
    });

    test("older version is not newer", () => {
      expect(isNewer("0.10.0", "0.11.1")).toBe(false);
    });

    test("handles v prefix", () => {
      expect(isNewer("v1.0.0", "0.11.1")).toBe(true);
    });

    test("handles missing patch segment", () => {
      expect(isNewer("1.0", "0.11.1")).toBe(true);
    });
  });
});
