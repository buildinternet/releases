/**
 * Collection daily-summary regression eval. LOCAL, AD-HOC ONLY — calls the real
 * Anthropic API (or an OpenRouter candidate). Run:
 *   bun run eval:collection-summary
 *   bun run eval:collection-summary -- --judge   (adds rubric faithfulness check)
 *
 * Never part of `bun test`. Each run costs roughly one Haiku call per fixture.
 * Results are persisted to ~/.releases/evals/results/collection-summary-*.json.
 */
import { readFileSync } from "fs";

import {
  summarizeCollectionDay,
  type CollectionSummaryResult,
} from "@releases/ai-internal/collection-summary";
// Anthropic baseline = the shared summarization model (the collection daily-summary
// lane reuses the SUMMARIZE_MODEL config + this Haiku fallback, not a bespoke one).
import { MODEL as COLLECTION_MODEL } from "@releases/ai-internal/release-content";
import type { TextModel } from "@releases/ai-internal/text-model";
import { buildGraderPrompt } from "@releases/ai-internal/grader-prompt";
import {
  loadCollectionSummaryFixtures,
  collectionSummaryRubricPath,
  type CollectionFixture,
} from "./collection-summary-fixtures";
import { OVERVIEW_BANNED_WORDS } from "./graders";
import type { FieldResult } from "./helpers";
import { resolveEvalModel, resolveJudgeModel, runJudge } from "./judge-model";
import { saveRun } from "./results";

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// Real day-windows captured from the prod backfill, one JSON file per fixture
// under fixtures/collection-summaries/. See collection-summary-fixtures.ts.

const FIXTURES: CollectionFixture[] = loadCollectionSummaryFixtures();

// ── Inline structural grader ───────────────────────────────────────────────
//
// Deliberately NOT reusing gradeStructural from ./graders — that function is
// shaped for the release-summary artifact ({summary, titleShort, skipped}).
// The collection-summary artifact ({title, summary, takeaways}) has distinct
// rules: title cap is 90 chars, summary must be ~one sentence, takeaways ≤ 5.

const TITLE_MAX_CHARS = 90;

/** Tag / markup tokens that must never appear in any output field. */
const LEAKAGE_TOKENS = ["</", "```", "<title", "<summary", "<item", "<takeaways"];

/** Trailing punctuation characters banned from the title. */
const TRAILING_PUNCT_RE = /[.!?,;:]$/;

/** Surrounding-quote pattern: leading/trailing straight or curly quote. */
const SURROUNDING_QUOTES_RE = /^["'""]|["'""]$/;

function gradeCollectionSummary(result: CollectionSummaryResult): {
  passed: boolean;
  fields: FieldResult[];
} {
  const fields: FieldResult[] = [];

  // title: non-empty
  const titleNonEmpty = result.title.trim().length > 0;
  fields.push({
    field: "title non-empty",
    passed: titleNonEmpty,
    expected: "non-empty",
    actual: result.title,
  });

  // title: length cap
  fields.push({
    field: "title length",
    passed: result.title.length <= TITLE_MAX_CHARS,
    expected: `<= ${TITLE_MAX_CHARS}`,
    actual: result.title.length,
  });

  // title: no trailing punctuation
  const trailingPunct = TRAILING_PUNCT_RE.test(result.title);
  fields.push({
    field: "title no trailing punctuation",
    passed: !trailingPunct,
    expected: "no trailing punctuation",
    actual: trailingPunct ? result.title.slice(-1) : "clean",
  });

  // title: no surrounding quotes
  const surroundingQuotes = SURROUNDING_QUOTES_RE.test(result.title);
  fields.push({
    field: "title no surrounding quotes",
    passed: !surroundingQuotes,
    expected: "no surrounding quotes",
    actual: surroundingQuotes ? result.title : "clean",
  });

  // summary: non-empty
  const summaryNonEmpty = result.summary.trim().length > 0;
  fields.push({
    field: "summary non-empty",
    passed: summaryNonEmpty,
    expected: "non-empty",
    actual: summaryNonEmpty ? "non-empty" : "empty",
  });

  // summary: roughly one sentence (≤ 1 sentence-ending punctuation, allowing a
  // single trailing period). Strategy: count [.!?] that are NOT at the very end.
  const summaryBody = result.summary.replace(/[.!?]$/, "");
  const interiorPunctCount = (summaryBody.match(/[.!?]/g) ?? []).length;
  fields.push({
    field: "summary single sentence",
    passed: interiorPunctCount <= 1,
    expected: "<= 1 interior sentence-ending punctuation",
    actual: interiorPunctCount,
  });

  // takeaways: count cap
  fields.push({
    field: "takeaways count",
    passed: result.takeaways.length <= 5,
    expected: "<= 5",
    actual: result.takeaways.length,
  });

  // leakage: title, summary, every takeaway
  const allTexts: Array<[string, string]> = [
    ["title", result.title],
    ["summary", result.summary],
    ...result.takeaways.map((t, i) => [`takeaway[${i}]`, t] as [string, string]),
  ];
  for (const [label, text] of allTexts) {
    const hit = LEAKAGE_TOKENS.find((tok) => text.includes(tok));
    fields.push({
      field: `no leakage (${label})`,
      passed: hit === undefined,
      expected: "clean",
      actual: hit ?? "clean",
    });
  }

  // banned marketing words: title, summary, every takeaway
  const allContent = [result.title, result.summary, ...result.takeaways].join(" ");
  const bannedHit = OVERVIEW_BANNED_WORDS.find((w) =>
    new RegExp(`\\b${w}\\b`, "i").test(allContent),
  );
  fields.push({
    field: "no banned marketing words",
    passed: bannedHit === undefined,
    expected: "clean",
    actual: bannedHit ?? "clean",
  });

  return { passed: fields.every((f) => f.passed), fields };
}

// ── Judge helper ───────────────────────────────────────────────────────────

// Wired to the rubric FILE (managed-agents/src/shared/rubrics/collection-summary.md), the same
// pattern overview.eval.ts uses — the rubric is the single source of truth for
// what "good" means, shared by grader and the production prompt's intent.
const COLLECTION_JUDGE_RUBRIC = readFileSync(collectionSummaryRubricPath(), "utf8");

async function judgeFixture(
  model: TextModel,
  fixture: CollectionFixture,
  result: CollectionSummaryResult,
): Promise<{ ok: boolean; result: string }> {
  const releasesBlock = fixture.input.releases
    .map((r) => {
      const label = r.product && r.product !== r.org ? `${r.org} / ${r.product}` : r.org;
      const tail = r.summary ? ` — ${r.summary}` : "";
      return `- ${label}: ${r.title}${tail}`;
    })
    .join("\n");

  const artifact = [
    `Collection: ${fixture.input.collectionName}`,
    `Date: ${fixture.input.date}`,
    `Releases:\n${releasesBlock}`,
    ``,
    `Generated title: ${result.title}`,
    `Generated summary: ${result.summary}`,
    `Generated takeaways:\n${result.takeaways.map((t) => `- ${t}`).join("\n")}`,
  ].join("\n");

  const prompt = buildGraderPrompt({
    rubric: COLLECTION_JUDGE_RUBRIC,
    artifact,
    rubricLabel: "collection-summary.md",
  });

  // The rubric carries ~20 criteria, each wanting an evidence quote, so give the
  // judge room to emit the full per-criterion JSON without truncating.
  return runJudge(model, prompt, 4096);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const useJudge = process.argv.includes("--judge");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — skipping collection-summary eval (no spend).");
    process.exit(0);
  }

  const summaryModel: TextModel = resolveEvalModel({
    anthropicModel: COLLECTION_MODEL,
    generationName: "collection-summary-eval",
    orModelEnvVar: "EVAL_OPENROUTER_MODEL",
    apiKey,
  })!.model;
  console.error(`model under test: ${summaryModel.id}`);

  const judgeModel = useJudge ? resolveJudgeModel(apiKey) : null;
  if (judgeModel) console.error(`judge model: ${judgeModel.id}`);

  let allPassed = true;
  console.error(`\n${"=".repeat(60)}`);
  console.error(
    `Collection daily-summary eval${useJudge ? " (+ judge)" : ""}: ${FIXTURES.length} fixtures`,
  );
  console.error("=".repeat(60));

  const runCases: Array<{ name: string; passed: boolean; fields: FieldResult[] }> = [];

  for (const fixture of FIXTURES) {
    let fields: FieldResult[];
    let passed: boolean;
    try {
      const result = await summarizeCollectionDay(summaryModel, fixture.input);
      ({ fields, passed } = gradeCollectionSummary(result));

      if (judgeModel) {
        const verdict = await judgeFixture(judgeModel, fixture, result);
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
          field: "summarizeCollectionDay throws",
          passed: false,
          expected: "no throw",
          actual: String(err),
        },
      ];
      passed = false;
    }

    allPassed = allPassed && passed;
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

  const file = saveRun({
    eval: "collection-summary",
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
