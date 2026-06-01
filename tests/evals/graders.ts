/**
 * Pure grading helpers for the local ad-hoc evals. No AI, no fs — unit-tested
 * deterministically in graders.test.ts (which DOES run under `bun test`).
 */
import type { FieldResult } from "./helpers";

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

// ── Structural grading (release summary, Tier 1) ───────────────────

/** Unambiguous leakage signals — always checked in summary + titleShort. */
export const DEFAULT_FORBIDDEN_SUBSTRINGS = ["</", "```", "Body:"];

export interface StructuralSpec {
  /** true => empty/boilerplate body: summary + titleShort must be null. */
  expectDiscarded: boolean;
  /** Defaults to true when not discarded. */
  summaryMustBeNonEmpty?: boolean;
  /** Per-fixture leakage tokens, on top of the defaults. */
  forbidInSummary?: string[];
}
export interface SummaryArtifact {
  summary: string | null;
  titleShort: string | null;
  skipped: boolean;
}
export interface StructuralGradeOptions {
  titleShortMaxChars?: number;
  /** Caller-injected tokens, e.g. the EMPTY_BODY_FALLBACK sentinel. */
  extraForbidden?: string[];
}
export interface StructuralGradeResult {
  passed: boolean;
  fields: FieldResult[];
}

export function gradeStructural(
  spec: StructuralSpec,
  artifact: SummaryArtifact,
  opts: StructuralGradeOptions = {},
): StructuralGradeResult {
  const fields: FieldResult[] = [];
  const max = opts.titleShortMaxChars ?? 120;

  if (spec.expectDiscarded) {
    fields.push({
      field: "summary discarded",
      passed: artifact.summary === null,
      expected: null,
      actual: artifact.summary,
    });
    fields.push({
      field: "titleShort discarded",
      passed: artifact.titleShort === null,
      expected: null,
      actual: artifact.titleShort,
    });
    return { passed: fields.every((f) => f.passed), fields };
  }

  const mustBeNonEmpty = spec.summaryMustBeNonEmpty ?? true;
  if (mustBeNonEmpty) {
    const nonEmpty = artifact.summary !== null && artifact.summary.trim().length > 0;
    fields.push({
      field: "summary non-empty",
      passed: nonEmpty,
      expected: "non-empty",
      actual: artifact.summary,
    });
  }

  const forbidden = [
    ...DEFAULT_FORBIDDEN_SUBSTRINGS,
    ...(opts.extraForbidden ?? []),
    ...(spec.forbidInSummary ?? []),
  ];
  for (const [label, text] of [
    ["summary", artifact.summary],
    ["titleShort", artifact.titleShort],
  ] as const) {
    if (text === null) continue;
    const hit = forbidden.find((tok) => text.includes(tok));
    fields.push({
      field: `no leakage (${label})`,
      passed: hit === undefined,
      expected: "clean",
      actual: hit ?? "clean",
    });
  }

  if (artifact.titleShort !== null) {
    fields.push({
      field: "titleShort length",
      passed: artifact.titleShort.length <= max,
      expected: `<= ${max}`,
      actual: artifact.titleShort.length,
    });
  }

  return { passed: fields.every((f) => f.passed), fields };
}
