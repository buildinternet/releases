import { test, expect, describe } from "bun:test";
import { isoToTitle, titleToIso, parseChangelog } from "../../scripts/changelog/changelog-md";

describe("date <-> title", () => {
  test("isoToTitle has no leading zero on the day", () => {
    expect(isoToTitle("2026-06-09")).toBe("June 9, 2026");
    expect(isoToTitle("2026-03-25")).toBe("March 25, 2026");
  });
  test("titleToIso round-trips and pads", () => {
    expect(titleToIso("June 9, 2026")).toBe("2026-06-09");
    expect(titleToIso("March 25, 2026")).toBe("2026-03-25");
  });
  test("titleToIso returns null for non-date headings", () => {
    expect(titleToIso("Unreleased")).toBeNull();
    expect(titleToIso("Notes")).toBeNull();
  });
  test("isoToTitle throws on malformed input", () => {
    expect(() => isoToTitle("")).toThrow();
    expect(() => isoToTitle("2026-13-40")).toThrow();
  });
});

describe("parseChangelog", () => {
  const md = `# Changelog

preamble line

## June 9, 2026

**Added**
- A
- B

## June 8, 2026

**Fixed**
- C
`;
  test("splits date sections, newest first, body captured verbatim", () => {
    const s = parseChangelog(md);
    expect(s.map((x) => x.dateIso)).toEqual(["2026-06-09", "2026-06-08"]);
    expect(s[0].title).toBe("June 9, 2026");
    expect(s[0].body).toBe("**Added**\n- A\n- B");
    expect(s[1].body).toBe("**Fixed**\n- C");
  });
  test("skips non-date level-2 headings", () => {
    const s = parseChangelog("# Changelog\n\n## Notes\n\nx\n\n## June 1, 2026\n\n**Added**\n- y");
    expect(s.map((x) => x.dateIso)).toEqual(["2026-06-01"]);
  });
  test("empty file → no sections", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("# Changelog\n\njust a preamble")).toEqual([]);
  });
  test("deeper (###) headings stay inside the section body", () => {
    const s = parseChangelog("## June 1, 2026\n\n### Sub\n- x");
    expect(s[0].body).toBe("### Sub\n- x");
  });
});
