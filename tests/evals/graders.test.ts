import { describe, it, expect } from "bun:test";
import { gradeBinary } from "./graders";

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
