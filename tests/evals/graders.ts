/**
 * Pure grading helpers for the local ad-hoc evals. No AI, no fs — unit-tested
 * deterministically in graders.test.ts (which DOES run under `bun test`).
 */

// ── Binary grading (marketing classifier) ──────────────────────────

export interface BinaryCase {
  id: string;
  /** Ground-truth label: true == marketing (should be suppressed). */
  expected: boolean;
}
export interface BinaryPrediction {
  id: string;
  predicted: boolean;
}
export interface BinaryGradeResult {
  total: number;
  correct: number;
  accuracy: number;
  /** Predicted marketing, actually a real release → a real release gets hidden. The costly error. */
  falsePositives: number;
  /** Predicted real, actually marketing → marketing slips through. The cheaper error. */
  falseNegatives: number;
  perCase: Array<{ id: string; expected: boolean; predicted: boolean; passed: boolean }>;
}

export function gradeBinary(
  cases: BinaryCase[],
  predictions: BinaryPrediction[],
): BinaryGradeResult {
  const byId = new Map(predictions.map((p) => [p.id, p.predicted]));
  let correct = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  const perCase: BinaryGradeResult["perCase"] = [];

  for (const c of cases) {
    if (!byId.has(c.id)) throw new Error(`no prediction for case "${c.id}"`);
    const predicted = byId.get(c.id)!;
    const passed = predicted === c.expected;
    if (passed) correct++;
    else if (predicted && !c.expected) falsePositives++;
    else if (!predicted && c.expected) falseNegatives++;
    perCase.push({ id: c.id, expected: c.expected, predicted, passed });
  }

  return {
    total: cases.length,
    correct,
    accuracy: cases.length > 0 ? correct / cases.length : 0,
    falsePositives,
    falseNegatives,
    perCase,
  };
}
