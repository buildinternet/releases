/**
 * Importance-score regression eval. LOCAL, AD-HOC ONLY — calls the real
 * Anthropic API (or an OpenRouter candidate). Run:
 *   bun run eval:importance                                        # Anthropic baseline (Haiku)
 *   EVAL_OPENROUTER_MODEL=deepseek/deepseek-v4-flash bun run eval:importance   # prod live lane
 *
 * Never part of `bun test`. The score is produced by the SAME `summarizeRelease`
 * call as title/summary/breaking (no extra request), so this runs each fixture
 * through `summarizeRelease` and grades `result.importance`. Each run costs
 * roughly one small model call per fixture. Results persist to
 * ~/.releases/evals/results/importance-*.json.
 *
 * Grading is deterministic (closed 1–5 scale, no LLM judge):
 *   - pass = within ±1 of the curated truth AND no false promotion
 *   - false promotion = truth ≤3 scored ≥4 (the web dot renders at ≥4, so a
 *     wrong promotion is feed noise — the costliest error, mirroring the
 *     breaking eval's precision guard)
 *   - exact accuracy is tracked and reported but not required to pass
 */

import { summarizeRelease, MODEL as SUMMARIZE_MODEL } from "@releases/ai-internal/release-content";
import type { TextModel } from "@releases/ai-internal/text-model";
import { IMPORTANCE_FIXTURES, type ImportanceFixture } from "./importance-fixtures";
import type { FieldResult } from "./helpers";
import { resolveEvalModel } from "./judge-model";
import { saveRun } from "./results";

function gradeFixture(
  fixture: ImportanceFixture,
  importance: number | null,
): { passed: boolean; exact: boolean; falsePromotion: boolean; fields: FieldResult[] } {
  const fields: FieldResult[] = [];

  // Skip-path fixture: an empty body must short-circuit to null.
  if (fixture.expected === null) {
    const passed = importance === null;
    fields.push({
      field: "empty body scores null",
      passed,
      expected: "null",
      actual: importance === null ? "null" : String(importance),
    });
    return { passed, exact: passed, falsePromotion: false, fields };
  }

  const exact = importance === fixture.expected;
  const withinOne = importance !== null && Math.abs(importance - fixture.expected) <= 1;
  fields.push({
    field: "score within ±1 of expected",
    passed: withinOne,
    expected: String(fixture.expected),
    actual: importance === null ? "null" : String(importance),
  });

  // Precision guard: a routine/notable release must never earn the feed dot.
  const falsePromotion = fixture.expected <= 3 && importance !== null && importance >= 4;
  fields.push({
    field: "no false promotion to >=4",
    passed: !falsePromotion,
    expected: `<=3 when truth is ${fixture.expected}`,
    actual: importance === null ? "null" : String(importance),
  });

  return { passed: withinOne && !falsePromotion, exact, falsePromotion, fields };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — skipping importance eval (no spend).");
    process.exit(0);
  }

  const model: TextModel = resolveEvalModel({
    anthropicModel: SUMMARIZE_MODEL,
    generationName: "importance-eval",
    orModelEnvVar: "EVAL_OPENROUTER_MODEL",
    // Mirror production resolveSummarizeModel: reasoning off so DeepSeek-class
    // models don't spend the 440-token cap thinking and return empty text.
    reasoning: { enabled: false },
  })!.model;
  console.error(`model under test: ${model.id}`);

  console.error(`\n${"=".repeat(60)}`);
  console.error(`Importance-score eval: ${IMPORTANCE_FIXTURES.length} fixtures`);
  console.error("=".repeat(60));

  const runCases: Array<{ name: string; passed: boolean; fields: FieldResult[] }> = [];
  let exactCount = 0;
  let withinOneCount = 0;
  let falsePromotions = 0;

  for (const fixture of IMPORTANCE_FIXTURES) {
    let fields: FieldResult[];
    let passed: boolean;
    try {
      const result = await summarizeRelease(model, fixture.input);
      const graded = gradeFixture(fixture, result.importance);
      fields = graded.fields;
      passed = graded.passed;
      if (graded.exact) exactCount++;
      if (graded.passed) withinOneCount++;
      if (graded.falsePromotion) falsePromotions++;
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
    const actual = fields[0]?.actual ?? "?";
    console.error(
      `  ${passed ? "PASS" : "FAIL"}  ${fixture.name} (expected=${fixture.expected ?? "null"}, actual=${actual})`,
    );
    for (const fld of fields) {
      if (!fld.passed) {
        console.error(
          `        ${fld.field}: expected=${JSON.stringify(fld.expected)}, actual=${JSON.stringify(fld.actual)}`,
        );
      }
    }
  }

  const total = IMPORTANCE_FIXTURES.length;
  const allPassed = runCases.every((c) => c.passed);
  console.error(
    `\nexact: ${exactCount}/${total}   within ±1 (pass): ${withinOneCount}/${total}   false promotions: ${falsePromotions}`,
  );

  const file = saveRun({
    eval: "importance",
    model: model.id,
    pass: allPassed,
    summary: { total, exact: exactCount, withinOne: withinOneCount, falsePromotions },
    cases: runCases,
  });
  console.error(`${allPassed ? "PASS" : "FAIL"}`);
  console.error(`results: ${file}\n`);
  process.exit(allPassed ? 0 : 1);
}

main();
