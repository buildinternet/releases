import { describe, it, expect } from "bun:test";
import {
  gradeBinary,
  gradeStructural,
  gradeOverviewStructural,
  gradeCitations,
  countOverviewWords,
  countOverviewMedia,
} from "./graders";

describe("gradeBinary", () => {
  it("computes accuracy and direction-split errors", () => {
    const cases = [
      { id: "a", expected: true }, // marketing
      { id: "b", expected: false }, // real release
      { id: "c", expected: false }, // real release
      { id: "d", expected: true }, // marketing
    ];
    const predictions = [
      { id: "a", predicted: true }, // correct
      { id: "b", predicted: true }, // FALSE POSITIVE — real release hidden
      { id: "c", predicted: false }, // correct
      { id: "d", predicted: false }, // false negative — marketing slipped through
    ];

    const r = gradeBinary(cases, predictions);

    expect(r.total).toBe(4);
    expect(r.correct).toBe(2);
    expect(r.accuracy).toBe(0.5);
    expect(r.falsePositives).toBe(1);
    expect(r.falseNegatives).toBe(1);
    expect(r.perCase.find((c) => c.id === "b")!.passed).toBe(false);
  });

  it("throws when a case has no prediction", () => {
    expect(() => gradeBinary([{ id: "x", expected: true }], [])).toThrow(/no prediction/i);
  });
});

const ok = {
  summary: "Query planner now parallelizes joins; cuts p99 by 30%.",
  titleShort: "Parallel joins land",
  skipped: false,
};

describe("gradeStructural", () => {
  it("passes when an empty body was discarded", () => {
    const r = gradeStructural(
      { expectDiscarded: true },
      { summary: null, titleShort: null, skipped: true },
    );
    expect(r.passed).toBe(true);
  });

  it("fails when a discard was expected but a summary was produced", () => {
    const r = gradeStructural({ expectDiscarded: true }, ok);
    expect(r.passed).toBe(false);
  });

  it("passes a clean non-empty summary", () => {
    const r = gradeStructural({ expectDiscarded: false }, ok);
    expect(r.passed).toBe(true);
  });

  it("fails on markdown-fence leakage", () => {
    const r = gradeStructural({ expectDiscarded: false }, { ...ok, summary: "```\nfoo\n```" });
    expect(r.passed).toBe(false);
  });

  it("fails when titleShort exceeds the length bound", () => {
    const r = gradeStructural(
      { expectDiscarded: false },
      { ...ok, titleShort: "x".repeat(200) },
      { titleShortMaxChars: 120 },
    );
    expect(r.passed).toBe(false);
  });

  it("fails when an extra-forbidden sentinel leaks into the summary", () => {
    const r = gradeStructural(
      { expectDiscarded: false },
      { ...ok, summary: "Release notes do not describe the change." },
      { extraForbidden: ["Release notes do not describe the change."] },
    );
    expect(r.passed).toBe(false);
  });
});

// A clean, rubric-compliant overview body used as the happy-path baseline.
const cleanOverview = `Recently shipped a parallel query planner and a redesigned audit log.

**The query planner now parallelizes joins.** Independent join branches run concurrently, cutting p99 latency on wide analytical queries by about 30%.

**Audit logs gained structured filters.** Operators can now scope by actor, resource, and time range without exporting the full stream:
- Filter by actor id or service account
- Scope to a single resource type
- Bound results to an arbitrary time window

**A breaking change landed in the Go SDK.** The \`Query\` builder now requires an explicit context argument; the old no-context overload was removed in \`v2.0.0\`.`;

const orgName = "Examplecorp";

describe("countOverviewWords", () => {
  it("ignores image syntax and reduces links to their text", () => {
    const a = countOverviewWords("Shipped a [new dashboard](https://x.dev/d) for teams.");
    const b = countOverviewWords("Shipped a new dashboard for teams.");
    expect(a).toBe(b);
    expect(countOverviewWords("![alt](https://x.dev/a.png) one two")).toBe(2);
  });
});

describe("countOverviewMedia", () => {
  it("counts images and video links but not ordinary links", () => {
    const body =
      "![shot](https://x.dev/a.png) [watch](https://youtu.be/abc) [docs](https://x.dev/docs)";
    expect(countOverviewMedia(body)).toBe(2);
  });
});

describe("gradeOverviewStructural", () => {
  it("passes a clean rubric-compliant body", () => {
    const r = gradeOverviewStructural(cleanOverview, { orgName });
    if (!r.passed) console.error(r.fields.filter((f) => !f.passed));
    expect(r.passed).toBe(true);
  });

  it("fails on a markdown heading anywhere in the body", () => {
    const r = gradeOverviewStructural(`## Overview\n${cleanOverview}`, { orgName });
    expect(r.passed).toBe(false);
    expect(r.fields.find((f) => f.field === "no markdown headings")!.passed).toBe(false);
  });

  it("fails when the body leads with a bare org-name title", () => {
    const r = gradeOverviewStructural(`**${orgName}**\n\n${cleanOverview}`, { orgName });
    expect(r.fields.find((f) => f.field === "no leading org-name title")!.passed).toBe(false);
  });

  it("fails under the word floor", () => {
    const r = gradeOverviewStructural("**Shipped a thing.** It works now.", { orgName });
    expect(r.fields.find((f) => f.field === "word count")!.passed).toBe(false);
  });

  it("fails on a banned buzzword", () => {
    const r = gradeOverviewStructural(cleanOverview.replace("cutting", "world-class cutting"), {
      orgName,
    });
    expect(r.fields.find((f) => f.field === "no banned buzzwords")!.passed).toBe(false);
  });

  it("fails on a filler / sign-off phrase", () => {
    const r = gradeOverviewStructural(`${cleanOverview}\n\nStay tuned for more!`, { orgName });
    expect(r.fields.find((f) => f.field === "no filler phrases")!.passed).toBe(false);
  });

  it("fails when more than two media items appear", () => {
    const media = "\n\n![a](https://x.dev/a.png) ![b](https://x.dev/b.png) [v](https://youtu.be/c)";
    const r = gradeOverviewStructural(cleanOverview + media, { orgName });
    expect(r.fields.find((f) => f.field === "media cap")!.passed).toBe(false);
  });

  it("fails on prompt-envelope leakage", () => {
    const r = gradeOverviewStructural(`${cleanOverview}\n<release-meta>v1</release-meta>`, {
      orgName,
    });
    expect(r.fields.find((f) => f.field === "no leakage")!.passed).toBe(false);
  });
});

describe("gradeCitations", () => {
  const sources = ["https://x.dev/r/1", "release://rel_2"];
  const body = "x".repeat(200);

  it("passes when every citation resolves and is in bounds", () => {
    const r = gradeCitations(
      body,
      [
        { startIndex: 0, endIndex: 20, sourceUrl: "https://x.dev/r/1", citedText: "shipped X" },
        { startIndex: 30, endIndex: 60, sourceUrl: "release://rel_2", citedText: "added Y" },
      ],
      sources,
    );
    expect(r.passed).toBe(true);
  });

  it("fails a citation whose source is not an input release", () => {
    const r = gradeCitations(
      body,
      [{ startIndex: 0, endIndex: 20, sourceUrl: "https://evil.example/x", citedText: "z" }],
      sources,
    );
    expect(r.fields.find((f) => f.field === "all sources resolve")!.passed).toBe(false);
  });

  it("fails an out-of-bounds offset span", () => {
    const r = gradeCitations(
      body,
      [{ startIndex: 0, endIndex: 9999, sourceUrl: "https://x.dev/r/1", citedText: "z" }],
      sources,
    );
    expect(r.fields.find((f) => f.field === "offsets in bounds")!.passed).toBe(false);
  });

  it("fails an empty cited-text span", () => {
    const r = gradeCitations(
      body,
      [{ startIndex: 0, endIndex: 20, sourceUrl: "https://x.dev/r/1", citedText: "  " }],
      sources,
    );
    expect(r.fields.find((f) => f.field === "cited text present")!.passed).toBe(false);
  });

  it("respects minCitations=0 for thin sources", () => {
    const r = gradeCitations(body, [], sources, { minCitations: 0 });
    expect(r.passed).toBe(true);
  });
});
