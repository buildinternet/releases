import { describe, it, expect } from "bun:test";
import { computeVersionSort } from "@buildinternet/releases-core/version-sort";

describe("computeVersionSort", () => {
  it("returns null for empty / nullish input", () => {
    expect(computeVersionSort(null)).toBeNull();
    expect(computeVersionSort(undefined)).toBeNull();
    expect(computeVersionSort("")).toBeNull();
    expect(computeVersionSort("   ")).toBeNull();
  });

  it("returns null for purely alphabetic codenames", () => {
    expect(computeVersionSort("jaguar")).toBeNull();
    expect(computeVersionSort("focal-fossa")).toBeNull();
  });

  it("orders semver versions so v16 > v15.5.18 (backport bug repro)", () => {
    // The bug: v15.5.18 backport ships after v16.x but appears as "latest"
    // because the aggregate sorts by published_at. The fix relies on lex
    // compare of version_sort giving v16 > v15.5.18.
    const v15Backport = computeVersionSort("15.5.18");
    const v16Latest = computeVersionSort("16.2.6");
    expect(v15Backport).not.toBeNull();
    expect(v16Latest).not.toBeNull();
    expect(v16Latest! > v15Backport!).toBe(true);
  });

  it("orders patch versions numerically, not lexicographically", () => {
    const v15_5_18 = computeVersionSort("15.5.18");
    const v15_10_2 = computeVersionSort("15.10.2");
    // Raw lex would say "5" > "10"; padding fixes that.
    expect(v15_10_2! > v15_5_18!).toBe(true);
  });

  it("orders 'v'-prefixed versions correctly", () => {
    const a = computeVersionSort("v1.0.0");
    const b = computeVersionSort("v2.0.0");
    expect(b! > a!).toBe(true);
  });

  it("sorts prereleases before their release counterpart", () => {
    const rc = computeVersionSort("1.0.0-rc.1");
    const release = computeVersionSort("1.0.0");
    expect(rc).not.toBeNull();
    expect(release).not.toBeNull();
    // `1.0.0-rc.1` < `1.0.0` per semver.
    expect(rc! < release!).toBe(true);
  });

  it("sorts multiple prereleases of the same version numerically", () => {
    const rc1 = computeVersionSort("1.0.0-rc.1");
    const rc2 = computeVersionSort("1.0.0-rc.2");
    expect(rc2! > rc1!).toBe(true);
  });

  it("max across a mixed bag picks the highest semver, not the alphabetically last", () => {
    const candidates = [
      "15.5.18", // backport, published last
      "16.0.0",
      "16.2.6", // actual latest
      "15.10.2",
      "16.1.7",
    ];
    const sorted = candidates
      .map((v) => ({ v, s: computeVersionSort(v) }))
      .filter((x) => x.s !== null)
      .toSorted((a, b) => (a.s! < b.s! ? -1 : a.s! > b.s! ? 1 : 0));
    expect(sorted.at(-1)!.v).toBe("16.2.6");
  });

  it("handles calendar versions", () => {
    const a = computeVersionSort("2024.10");
    const b = computeVersionSort("2025.01");
    expect(b! > a!).toBe(true);
  });

  it("pads only the leading digit run in mixed segments", () => {
    // Documents intentional behavior: the segment regex matches `^([^\d]*)(\d+)(.*)$`,
    // so only the first numeric run gets padded. Embedded trailing digits stay raw,
    // which means `alpha2beta10` vs `alpha2beta3` won't sort numerically on the
    // second number — acceptable because real version strings don't look like this.
    const a = computeVersionSort("alpha2beta3");
    const b = computeVersionSort("alpha2beta10");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Lex compare: "...beta10" < "...beta3" because '1' < '3'. Pinning the
    // current behavior so a future fix is intentional, not silent.
    expect(b! < a!).toBe(true);
  });

  it("handles build metadata after `+`", () => {
    const release = computeVersionSort("1.0.0");
    const withBuild = computeVersionSort("1.0.0+build123");
    expect(release).not.toBeNull();
    expect(withBuild).not.toBeNull();
    // Same release prefix; build suffix sorts the metadata version higher
    // under lex compare. Semver actually says build metadata is ignored for
    // ordering — we don't follow that strictly, but the result is stable.
    expect(withBuild! > release!).toBe(true);
  });
});
