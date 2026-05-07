import { describe, test, expect } from "bun:test";
import { isPrereleaseVersion } from "@buildinternet/releases-core/prerelease";

describe("isPrereleaseVersion", () => {
  test.each([
    "v0.42.0-preview.1",
    "v0.42.0-preview.2",
    "v0.42.0-nightly.20260506.g80d269054",
    "v1.0.0-rc.2",
    "1.0.0-alpha",
    "1.0.0-alpha.3",
    "1.0.0-beta.1",
    "v2.0.0-pre.4",
    "0.5.0-canary.7",
    "5.0.0-next.42",
    "1.2.3-dev",
    "3.0.0-snapshot",
    "1.0.0-M1",
    "1.0.0-milestone.2",
    "v22.0.0-edge",
    "1.0.0-insider",
    "1.0.0-experimental",
    "1.0.0-early-access",
  ])("flags %s as prerelease", (v) => {
    expect(isPrereleaseVersion(v)).toBe(true);
  });

  test.each(["v1.0.0", "1.0.0", "v0.41.2", "2024.05.07", "v22-lts", "v1.0.0+build.123"])(
    "does not flag %s as prerelease",
    (v) => {
      expect(isPrereleaseVersion(v)).toBe(false);
    },
  );

  test("handles null/undefined/empty", () => {
    expect(isPrereleaseVersion(null)).toBe(false);
    expect(isPrereleaseVersion(undefined)).toBe(false);
    expect(isPrereleaseVersion("")).toBe(false);
    expect(isPrereleaseVersion("   ")).toBe(false);
  });
});
