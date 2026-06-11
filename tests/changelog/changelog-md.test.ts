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

import {
  renderChangelog,
  diffChangelog,
  sectionToRelease,
  planPublish,
} from "../../scripts/changelog/changelog-md";

describe("renderChangelog", () => {
  test("newest-first, has preamble, round-trips with parseChangelog", () => {
    const md = renderChangelog([
      { dateIso: "2026-06-08", body: "**Fixed**\n- C" },
      { dateIso: "2026-06-09", body: "**Added**\n- A" },
    ]);
    expect(md.startsWith("# Changelog")).toBe(true);
    const s = parseChangelog(md);
    expect(s.map((x) => x.dateIso)).toEqual(["2026-06-09", "2026-06-08"]);
    expect(s[0].body).toBe("**Added**\n- A");
  });
});

describe("diffChangelog", () => {
  const before =
    "# Changelog\n\n## June 9, 2026\n\n**Added**\n- A\n\n## June 8, 2026\n\n**Fixed**\n- C";
  test("detects added, modified, and ignores unchanged", () => {
    const after =
      "# Changelog\n\n## June 10, 2026\n\n**Added**\n- NEW\n\n## June 9, 2026\n\n**Added**\n- A EDITED\n\n## June 8, 2026\n\n**Fixed**\n- C";
    const d = diffChangelog(before, after);
    expect(d.added).toEqual(["2026-06-10"]);
    expect(d.modified).toEqual(["2026-06-09"]);
  });
  test("empty before → every section is added", () => {
    const d = diffChangelog("", before);
    expect(d.added).toEqual(["2026-06-09", "2026-06-08"]);
    expect(d.modified).toEqual([]);
  });
  test("identical before/after → nothing changed", () => {
    expect(diffChangelog(before, before)).toEqual({ added: [], modified: [] });
  });
});

describe("sectionToRelease + planPublish", () => {
  test("maps a section to the /batch release shape", () => {
    const r = sectionToRelease({
      dateIso: "2026-06-09",
      title: "June 9, 2026",
      body: "**Added**\n- A",
    });
    expect(r).toEqual({
      title: "June 9, 2026",
      content: "**Added**\n- A",
      url: "https://releases.sh/updates/2026-06-09",
      publishedAt: "2026-06-09T12:00:00Z",
      type: "rollup",
    });
  });
  test("planPublish returns added/modified + releases for changed dates only", () => {
    const before = "# Changelog\n\n## June 9, 2026\n\n**Added**\n- A";
    const after =
      "# Changelog\n\n## June 10, 2026\n\n**Added**\n- NEW\n\n## June 9, 2026\n\n**Added**\n- A";
    const plan = planPublish(before, after);
    expect(plan.added).toEqual(["2026-06-10"]);
    expect(plan.modified).toEqual([]);
    expect(plan.releases.map((r) => r.url)).toEqual(["https://releases.sh/updates/2026-06-10"]);
  });
});
