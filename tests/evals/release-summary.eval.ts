/**
 * Release-summary regression eval. LOCAL, AD-HOC ONLY — calls the real Anthropic
 * API. Run: `bun run eval:summary` (Tier-1 structural) or `bun run eval:summary -- --judge`
 * (adds the rubric faithfulness check — judged by Gemini 2.5 Flash via OpenRouter
 * by default; see ./judge-model.ts). Never part of `bun test`.
 */
import { readFileSync, readdirSync } from "fs";
import { basename, join } from "path";

import {
  summarizeRelease,
  EMPTY_BODY_FALLBACK,
  MODEL as SUMMARY_MODEL,
  type SummarizeReleaseInput,
} from "@releases/ai-internal/release-content";
import { type TextModel } from "@releases/ai-internal/text-model";
import { buildGraderPrompt } from "@releases/ai-internal/grader-prompt";
import { gradeStructural, type StructuralSpec } from "./graders";
import type { FieldResult } from "./helpers";
import { resolveEvalModel, resolveJudgeModel, runJudge } from "./judge-model";
import { saveRun } from "./results";

const TITLE_SHORT_MAX_CHARS = 120;

interface SummaryFixture {
  name: string;
  input: SummarizeReleaseInput;
  spec: StructuralSpec;
}

function loadFixtures(dir: string): SummaryFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((mdFile) => {
      const name = basename(mdFile, ".md");
      const meta = JSON.parse(readFileSync(join(dir, `${name}.expected.json`), "utf8")) as {
        input: Omit<SummarizeReleaseInput, "content">;
        spec: StructuralSpec;
      };
      const content = readFileSync(join(dir, mdFile), "utf8");
      return { name, input: { ...meta.input, content }, spec: meta.spec };
    });
}

async function judge(
  model: TextModel,
  rubric: string,
  body: string,
  summary: string,
): Promise<{ ok: boolean; result: string }> {
  const prompt = buildGraderPrompt({
    rubric,
    artifact: `BODY:\n${body}\n\nSUMMARY:\n${summary}`,
    rubricLabel: "release-summary.md",
  });
  // 2K cap (up from 1K): the faithfulness rubric verdict is short, but an
  // OpenRouter judge that emits reasoning tokens needs headroom or it returns
  // empty text → "unparseable".
  return runJudge(model, prompt, 2048);
}

async function main() {
  const useJudge = process.argv.includes("--judge");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — skipping summary eval (no spend).");
    process.exit(0);
  }

  const dir = join(import.meta.dir, "fixtures", "summaries");
  const fixtures = loadFixtures(dir);
  const summaryModel: TextModel = resolveEvalModel({
    anthropicModel: SUMMARY_MODEL,
    generationName: "summarize-eval",
    orModelEnvVar: "EVAL_OPENROUTER_MODEL",
  })!.model;
  console.error(`model under test: ${summaryModel.id}`);
  const rubric = useJudge
    ? readFileSync(
        join(
          import.meta.dir,
          "..",
          "..",
          "managed-agents",
          "src",
          "shared",
          "rubrics",
          "release-summary.md",
        ),
        "utf8",
      )
    : "";
  // Judge defaults to a cheap OpenRouter model (Gemini Flash); JUDGE_MODEL
  // overrides it (e.g. claude-sonnet-4-6 for Anthropic). See ./judge-model.ts.
  const judgeModel = useJudge ? resolveJudgeModel() : null;
  if (judgeModel) console.error(`judge model: ${judgeModel.id}`);

  let allPassed = true;
  console.error(`\n${"=".repeat(60)}`);
  console.error(`Release summary eval${useJudge ? " (+ judge)" : ""}: ${fixtures.length} fixtures`);
  console.error("=".repeat(60));

  const runCases: Array<{ name: string; passed: boolean; fields: FieldResult[] }> = [];

  for (const f of fixtures) {
    let fields: FieldResult[];
    let passed: boolean;
    try {
      const result = await summarizeRelease(summaryModel, f.input);
      ({ fields, passed } = gradeStructural(f.spec, result, {
        titleShortMaxChars: TITLE_SHORT_MAX_CHARS,
        extraForbidden: [EMPTY_BODY_FALLBACK],
      }));

      if (judgeModel && !f.spec.expectDiscarded && result.summary) {
        const verdict = await judge(judgeModel, rubric, f.input.content, result.summary);
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
          field: "summarizeRelease throws",
          passed: false,
          expected: "no throw",
          actual: String(err),
        },
      ];
      passed = false;
    }

    allPassed = allPassed && passed;
    runCases.push({ name: f.name, passed, fields });
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
    eval: "summary",
    model: summaryModel.id,
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

main();
