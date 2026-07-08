/**
 * Breaking-change verdict regression eval. LOCAL, AD-HOC ONLY — calls the real
 * Anthropic API (or an OpenRouter candidate). Run:
 *   bun run eval:breaking
 *
 * Never part of `bun test`. The breaking verdict is produced by the SAME
 * `summarizeRelease` call as title/summary (#1696, no extra request), so this
 * runs each fixture through `summarizeRelease` and grades `result.breaking`.
 * Each run costs roughly one Haiku call per fixture. Results persist to
 * ~/.releases/evals/results/breaking-*.json.
 *
 * The verdict is a closed enum, so the grade is deterministic: exact accuracy
 * plus a PRECISION guard (a `none`/`unknown` truth answered `minor`/`major` is a
 * false alarm — the costliest error per managed-agents/src/shared/rubrics/breaking.md).
 */

import { summarizeRelease, MODEL as SUMMARIZE_MODEL } from "@releases/ai-internal/release-content";
import type { TextModel } from "@releases/ai-internal/text-model";
import { BREAKING_FIXTURES, type BreakingFixture } from "./breaking-fixtures";
import type { FieldResult } from "./helpers";
import { resolveEvalModel } from "./judge-model";
import { saveRun } from "./results";

const ABSTAIN_OR_SAFE = new Set(["none", "unknown"]);
const ALARM = new Set(["minor", "major"]);

function gradeFixture(
  fixture: BreakingFixture,
  verdict: string,
  migrationNotes: string | null,
): { passed: boolean; falseAlarm: boolean; fields: FieldResult[] } {
  const fields: FieldResult[] = [];

  fields.push({
    field: "verdict matches expected",
    passed: verdict === fixture.expected,
    expected: fixture.expected,
    actual: verdict,
  });

  // Precision guard: a release whose truth is none/unknown must never be
  // classified minor/major (the worst error per the rubric).
  const falseAlarm = ABSTAIN_OR_SAFE.has(fixture.expected) && ALARM.has(verdict);
  fields.push({
    field: "no false alarm",
    passed: !falseAlarm,
    expected: `not minor/major when truth is ${fixture.expected}`,
    actual: verdict,
  });

  // migrationNotes must be null when there's no break / we don't know.
  const notesShapeOk = ABSTAIN_OR_SAFE.has(verdict) ? migrationNotes === null : true;
  fields.push({
    field: "migration notes null when none/unknown",
    passed: notesShapeOk,
    expected: ABSTAIN_OR_SAFE.has(verdict) ? "null" : "n/a",
    actual: migrationNotes ?? "null",
  });

  return { passed: fields.every((f) => f.passed), falseAlarm, fields };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — skipping breaking eval (no spend).");
    process.exit(0);
  }

  const model: TextModel = resolveEvalModel({
    anthropicModel: SUMMARIZE_MODEL,
    generationName: "breaking-eval",
    orModelEnvVar: "EVAL_OPENROUTER_MODEL",
    apiKey,
  })!.model;
  console.error(`model under test: ${model.id}`);

  console.error(`\n${"=".repeat(60)}`);
  console.error(`Breaking-change verdict eval: ${BREAKING_FIXTURES.length} fixtures`);
  console.error("=".repeat(60));

  const runCases: Array<{ name: string; passed: boolean; fields: FieldResult[] }> = [];
  let correct = 0;
  let falseAlarms = 0;

  for (const fixture of BREAKING_FIXTURES) {
    let fields: FieldResult[];
    let passed: boolean;
    try {
      const result = await summarizeRelease(model, fixture.input);
      const graded = gradeFixture(fixture, result.breaking, result.migrationNotes);
      fields = graded.fields;
      passed = graded.passed;
      if (result.breaking === fixture.expected) correct++;
      if (graded.falseAlarm) falseAlarms++;
    } catch (err) {
      fields = [
        {
          field: "summarizeRelease throws",
          passed: false,
          expected: "no throw",
          actual: String(err),
        },
      ];
      passed = false;
    }

    runCases.push({ name: fixture.name, passed, fields });
    console.error(`  ${passed ? "PASS" : "FAIL"}  ${fixture.name}`);
    for (const fld of fields) {
      if (!fld.passed) {
        console.error(
          `        ${fld.field}: expected=${JSON.stringify(fld.expected)}, actual=${JSON.stringify(fld.actual)}`,
        );
      }
    }
  }

  const total = BREAKING_FIXTURES.length;
  const allPassed = runCases.every((c) => c.passed);
  console.error(`\naccuracy: ${correct}/${total}   false alarms: ${falseAlarms}`);

  const file = saveRun({
    eval: "breaking",
    model: model.id,
    pass: allPassed,
    summary: { total, correct, falseAlarms },
    cases: runCases,
  });
  console.error(`${allPassed ? "PASS" : "FAIL"}`);
  console.error(`results: ${file}\n`);
  process.exit(allPassed ? 0 : 1);
}

main();
