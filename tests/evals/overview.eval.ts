/**
 * Org-overview regression eval. LOCAL, AD-HOC ONLY — calls the real Anthropic
 * API. Run: `bun run eval:overview` (Tier-1 structural + citation integrity) or
 * `bun run eval:overview -- --judge` (adds the rubric faithfulness check against
 * managed-agents/src/shared/rubrics/overview.md — judged by Gemini 2.5 Flash via OpenRouter by
 * default; see ./judge-model.ts). Never part of `bun test`.
 *
 * Each fixture is a single JSON file under fixtures/overviews/ carrying the
 * OverviewRequestInput the production overview-regen workflow would build, plus
 * optional per-fixture grading knobs. The eval exercises the exact production
 * path: generateOverview (the real shipped function), then grades the body and
 * the emitted citations. Set OVERVIEW_EVAL_MODEL + OPENROUTER_API_KEY to bench
 * an OpenRouter candidate against the same fixtures.
 */
import { readFileSync } from "fs";

import {
  generateOverview,
  releaseSource,
  MODEL,
  type OverviewRequestInput,
} from "@releases/ai-internal/overview-content";
import { buildGraderPrompt } from "@releases/ai-internal/grader-prompt";
import type { TextModel } from "@releases/ai-internal/text-model";
import { gradeOverviewStructural, gradeCitations } from "./graders";
import { loadOverviewFixtures, overviewRubricPath } from "./overview-fixtures";
import type { FieldResult } from "./helpers";
import {
  extractJudgeJson,
  resolveJudgeModel,
  resolveOverviewEvalModel,
  runJudge,
} from "./judge-model";
import { saveRun } from "./results";

// Re-exported for any unit test that imports it from this module.
export { extractJudgeJson };

/** The citation source set the API can legitimately resolve to — same keys `generateOverview` resolves citations against. */
function validSources(input: OverviewRequestInput): string[] {
  return input.selected.map(releaseSource);
}

async function judge(
  model: TextModel,
  rubric: string,
  body: string,
): Promise<{ ok: boolean; result: string }> {
  const prompt = buildGraderPrompt({ rubric, artifact: body, rubricLabel: "overview.md" });
  // The rubric has ~24 criteria, each with an evidence quote, so the JSON
  // verdict runs well past 2K tokens; a low cap truncates it to invalid JSON.
  // 8K leaves comfortable headroom (and room for OpenRouter reasoning tokens).
  return runJudge(model, prompt, 8192);
}

async function main() {
  const useJudge = process.argv.includes("--judge");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — skipping overview eval (no spend).");
    process.exit(0);
  }

  const fixtures = loadOverviewFixtures();
  // Model under test: OpenRouter candidate when OVERVIEW_EVAL_MODEL is set,
  // else the Anthropic Haiku production baseline (MODEL). Returns an AI SDK
  // `LanguageModel` (the structured-output path), mirroring production
  // `resolveOverviewModel`. `apiKey` is set (checked above), so it never nulls.
  const resolved = resolveOverviewEvalModel({
    anthropicModel: MODEL,
    generationName: "org-overview-eval",
    orModelEnvVar: "OVERVIEW_EVAL_MODEL",
  });
  if (!resolved) {
    console.error("No generation model available — skipping overview eval.");
    process.exit(0);
  }
  console.error(`generation model: ${resolved.label}`);

  const rubric = useJudge ? readFileSync(overviewRubricPath(), "utf8") : "";
  // Judge defaults to a cheap OpenRouter model (Gemini Flash); JUDGE_MODEL
  // overrides it (e.g. claude-sonnet-4-6 for Anthropic). See ./judge-model.ts.
  const judgeModel = useJudge ? resolveJudgeModel() : null;

  let allPassed = true;
  console.error(`\n${"=".repeat(60)}`);
  console.error(`Org overview eval${useJudge ? " (+ judge)" : ""}: ${fixtures.length} fixtures`);
  if (judgeModel) console.error(`judge model: ${judgeModel.id}`);
  console.error("=".repeat(60));

  const runCases: Array<{ name: string; passed: boolean; fields: FieldResult[]; body?: string }> =
    [];

  for (const f of fixtures) {
    let fields: FieldResult[];
    let passed: boolean;
    let body: string | undefined;
    try {
      const { body: genBody, citations } = await generateOverview(resolved.model, f.input);
      body = genBody;

      const structural = gradeOverviewStructural(body, {
        orgName: f.input.org.name,
        ...f.structural,
      });
      const citationGrade = gradeCitations(body, citations, validSources(f.input), f.citations);
      fields = [...structural.fields, ...citationGrade.fields];
      passed = structural.passed && citationGrade.passed;

      if (judgeModel && body.trim().length > 0) {
        const verdict = await judge(judgeModel, rubric, body);
        fields = [
          ...fields,
          {
            field: "judge: satisfied",
            passed: verdict.ok,
            expected: "satisfied",
            actual: verdict.result,
          },
        ];
        passed = passed && verdict.ok;
      }
    } catch (err) {
      fields = [
        {
          field: "generateOverview throws",
          passed: false,
          expected: "no throw",
          actual: String(err),
        },
      ];
      passed = false;
    }

    allPassed = allPassed && passed;
    runCases.push({ name: f.name, passed, fields, body });
    console.error(`  ${passed ? "PASS" : "FAIL"}  ${f.name}`);
    for (const fld of fields) {
      if (!fld.passed) {
        console.error(
          `        ${fld.field}: expected=${JSON.stringify(fld.expected)}, actual=${JSON.stringify(fld.actual)}`,
        );
      }
    }
  }

  const file = saveRun({
    eval: "overview",
    model: resolved.label,
    pass: allPassed,
    summary: {
      total: runCases.length,
      passed: runCases.filter((c) => c.passed).length,
      judge: useJudge,
      judgeModel: judgeModel?.id ?? null,
    },
    cases: runCases,
  });
  console.error(`\n${allPassed ? "PASS" : "FAIL"}`);
  console.error(`results: ${file}\n`);
  process.exit(allPassed ? 0 : 1);
}

// Only run when invoked as a script (`bun run eval:overview`), not on import —
// keeps the module importable for unit-testing helpers like extractJudgeJson.
if (import.meta.main) main();
