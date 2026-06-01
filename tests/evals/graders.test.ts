import { describe, it, expect } from "bun:test";
import { gradeBinary, gradeStructural } from "./graders";

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
