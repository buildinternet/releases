/**
 * Weekly-digest generation model-comparison eval. LOCAL, AD-HOC ONLY — calls
 * the real Anthropic API (or an OpenRouter candidate). Run:
 *   bun run eval:weekly-digest
 *   bun run eval:weekly-digest -- --judge     (adds rubric judge)
 *   bun run eval:weekly-digest -- --dry-run   (canned model, zero API cost —
 *                                               exercises parsing + structural
 *                                               graders only)
 *
 * Model under test:
 *   - default: the shared Anthropic summarize-lane model (`MODEL` from
 *     `@releases/ai-internal/release-content`), matching production's
 *     `resolveCollectionWeeklyDigestModel` fallback.
 *   - `EVAL_MODEL=<openrouter slug>`: candidate lane via OpenRouter, reasoning
 *     disabled (mirrors production `resolveSummarizeModel` — a reasoning model
 *     otherwise burns the small output cap on chain-of-thought and returns
 *     empty text, #1633).
 *
 * Never part of `bun test`. Results persist to
 * ~/.releases/evals/results/weekly-digest-*.json. See
 * .context/2026-07-11-seo-ws3-digest-model-eval.md for the full protocol.
 */
import { readFileSync } from "fs";

import {
  buildCollectionWeekBlock,
  MAX_OUTPUT_TOKENS,
  parseWeeklyDigest,
  resolveReleasePlaceholders,
  selectWeeklyDigestReleases,
  SYSTEM_PROMPT,
  type CollectionWeekInput,
} from "@releases/ai-internal/collection-weekly-digest";
// Anthropic baseline = the shared summarize-lane model (the weekly-digest lane
// reuses the SUMMARIZE_MODEL config + this Haiku fallback, not a bespoke one —
// see resolveCollectionWeeklyDigestModel in workers/api/src/lib/text-model.ts).
import { MODEL as DIGEST_MODEL } from "@releases/ai-internal/release-content";
import type { TextModel, TextModelUsage } from "@releases/ai-internal/text-model";
import { buildGraderPrompt } from "@releases/ai-internal/grader-prompt";
import { releasePath } from "@buildinternet/releases-core/release-slug";
import { estimateCost } from "@releases/lib/anthropic-pricing";
import {
  loadWeeklyDigestFixtures,
  weeklyDigestRubricPath,
  type WeeklyDigestFixture,
} from "./weekly-digest-fixtures";
import { OVERVIEW_BANNED_WORDS } from "./graders";
import type { FieldResult } from "./helpers";
import { resolveEvalModel, resolveJudgeModel, runJudge } from "./judge-model";
import { saveRun } from "./results";

const FIXTURES: WeeklyDigestFixture[] = loadWeeklyDigestFixtures();

// ── Structural grader ───────────────────────────────────────────────────────

const TITLE_MAX_CHARS = 90;
const BODY_MIN_WORDS = 250;
const BODY_MAX_WORDS = 700;
const MIN_SECTIONS = 2;
const MAX_SECTIONS = 4;
const MIN_PLACEHOLDERS = 3;
const MAX_BULLET_LINE_RATIO = 0.4;

/** Tag / markup tokens that must never appear in any output field. */
const LEAKAGE_TOKENS = ["</", "```", "<title", "<intro", "<body", "<releases"];

const TRAILING_PUNCT_RE = /[.!?,;:]$/;
const SURROUNDING_QUOTES_RE = /^["'""]|["'""]$/;
/** `[anchor](rel:rel_ID)` placeholder, pre-link-resolution. */
const REL_PLACEHOLDER_RE = /\[([^\]]*)\]\(rel:([A-Za-z0-9_-]+)\)/g;
const HEADING_RE = /^###\s+\S/gm;
const BULLET_LINE_RE = /^\s*([-*]|\d+\.)\s+/;

interface DigestRunResult {
  raw: string;
  title: string;
  intro: string;
  /** Pre-link-resolution body — still carries `(rel:rel_ID)` placeholders. */
  bodyRaw: string;
  /** The model's self-reported `<releases>` tag content, split + trimmed. */
  citedIds: string[];
  usage: TextModelUsage;
}

/** Run one fixture through the model, keeping intermediate (pre-resolution)
 * values so the structural grader can check link discipline against what the
 * model actually emitted — not the post-drop, already-sanitized result. */
async function runDigest(model: TextModel, input: CollectionWeekInput): Promise<DigestRunResult> {
  const selection = selectWeeklyDigestReleases(input.releases);
  const { text, usage } = await model.complete({
    system: SYSTEM_PROMPT,
    user: buildCollectionWeekBlock(input, selection),
    maxTokens: MAX_OUTPUT_TOKENS,
    cacheSystem: true,
  });
  const parsed = parseWeeklyDigest(text);
  return {
    raw: text,
    title: parsed.title,
    intro: parsed.intro,
    bodyRaw: parsed.body,
    citedIds: parsed.citedIds,
    usage,
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countSentences(text: string): number {
  const stripped = text.trim().replace(/[.!?]$/, "");
  return (stripped.match(/[.!?]/g) ?? []).length + 1;
}

function gradeWeeklyDigest(
  result: DigestRunResult,
  fixture: WeeklyDigestFixture,
): { passed: boolean; fields: FieldResult[] } {
  const fields: FieldResult[] = [];
  const { title, intro, bodyRaw, citedIds } = result;
  const fixtureIds = new Set(fixture.input.releases.map((r) => r.id));

  // ── format ──
  fields.push({
    field: "title non-empty",
    passed: title.trim().length > 0,
    expected: "non-empty",
    actual: title,
  });
  fields.push({
    field: "title length",
    passed: title.length <= TITLE_MAX_CHARS,
    expected: `<= ${TITLE_MAX_CHARS}`,
    actual: title.length,
  });
  const trailingPunct = TRAILING_PUNCT_RE.test(title);
  fields.push({
    field: "title no trailing punctuation",
    passed: !trailingPunct,
    expected: "no trailing punctuation",
    actual: trailingPunct ? title.slice(-1) : "clean",
  });
  const surroundingQuotes = SURROUNDING_QUOTES_RE.test(title);
  fields.push({
    field: "title no surrounding quotes",
    passed: !surroundingQuotes,
    expected: "no surrounding quotes",
    actual: surroundingQuotes ? title : "clean",
  });
  // Formulaic-title screen: "Week ... <digit>" as the whole title (e.g. "Week
  // of July 6 digest") is a fail — title must be editorial, not a date label.
  const formulaic = /week/i.test(title) && /\d/.test(title);
  fields.push({
    field: "title not formulaic (week + digit)",
    passed: !formulaic,
    expected: "editorial headline, not a date label",
    actual: formulaic ? title : "clean",
  });

  const sentenceCount = countSentences(intro);
  fields.push({
    field: "intro 1-2 sentences",
    passed: intro.trim().length > 0 && sentenceCount >= 1 && sentenceCount <= 2,
    expected: "1-2 sentences",
    actual: sentenceCount,
  });

  const wordCount = countWords(bodyRaw);
  fields.push({
    field: "body word count",
    passed: wordCount >= BODY_MIN_WORDS && wordCount <= BODY_MAX_WORDS,
    expected: `${BODY_MIN_WORDS}-${BODY_MAX_WORDS} words`,
    actual: wordCount,
  });

  const headingCount = (bodyRaw.match(HEADING_RE) ?? []).length;
  fields.push({
    field: "body section count",
    passed: headingCount >= MIN_SECTIONS && headingCount <= MAX_SECTIONS,
    expected: `${MIN_SECTIONS}-${MAX_SECTIONS} ### sections`,
    actual: headingCount,
  });

  // Narrative-prose heuristic: bullet lines should be a minority of the
  // non-heading, non-blank lines.
  const nonHeadingLines = bodyRaw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("###"));
  const bulletLines = nonHeadingLines.filter((l) => BULLET_LINE_RE.test(l));
  const bulletRatio = nonHeadingLines.length > 0 ? bulletLines.length / nonHeadingLines.length : 0;
  fields.push({
    field: "body is narrative prose, not a bullet dump",
    passed: bulletRatio < MAX_BULLET_LINE_RATIO,
    expected: `bullet-line ratio < ${MAX_BULLET_LINE_RATIO}`,
    actual: Number(bulletRatio.toFixed(2)),
  });

  // ── link discipline (hard gate) ──
  const placeholderIds: string[] = [];
  for (const m of bodyRaw.matchAll(REL_PLACEHOLDER_RE)) {
    placeholderIds.push(m[2]);
  }
  fields.push({
    field: "link discipline: at least 3 placeholders",
    passed: placeholderIds.length >= MIN_PLACEHOLDERS,
    expected: `>= ${MIN_PLACEHOLDERS}`,
    actual: placeholderIds.length,
  });
  const unknownPlaceholderIds = placeholderIds.filter((id) => !fixtureIds.has(id));
  fields.push({
    field: "link discipline: every placeholder id is a real fixture release",
    passed: unknownPlaceholderIds.length === 0,
    expected: "0 unknown ids",
    actual: unknownPlaceholderIds.length === 0 ? "clean" : unknownPlaceholderIds.join(","),
  });
  const unknownCitedIds = citedIds.filter((id) => !fixtureIds.has(id));
  fields.push({
    field: "link discipline: <releases> tag ids are all real fixture releases",
    passed: unknownCitedIds.length === 0,
    expected: "0 unknown ids",
    actual: unknownCitedIds.length === 0 ? "clean" : unknownCitedIds.join(","),
  });

  // ── coverage floor ──
  const highImportanceIds = fixture.input.releases
    .filter((r) => (r.importance ?? 0) >= 4)
    .map((r) => r.id);
  const placeholderIdSet = new Set(placeholderIds);
  const missingHighImportance = highImportanceIds.filter((id) => !placeholderIdSet.has(id));
  fields.push({
    field: "coverage floor: every importance>=4 release is cited",
    passed: missingHighImportance.length === 0,
    expected: `all ${highImportanceIds.length} importance>=4 releases cited`,
    actual:
      missingHighImportance.length === 0 ? "clean" : `missing ${missingHighImportance.join(",")}`,
  });

  // ── leakage + banned words ──
  const allTexts: Array<[string, string]> = [
    ["title", title],
    ["intro", intro],
    ["body", bodyRaw],
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
  const allContent = [title, intro, bodyRaw].join(" ");
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

const WEEKLY_DIGEST_JUDGE_RUBRIC = readFileSync(weeklyDigestRubricPath(), "utf8");

async function judgeFixture(
  model: TextModel,
  fixture: WeeklyDigestFixture,
  result: DigestRunResult,
): Promise<{ ok: boolean; result: string }> {
  const releasesBlock = fixture.input.releases
    .map((r) => {
      const label = r.product && r.product !== r.org ? `${r.org} / ${r.product}` : r.org;
      const tail = r.summary ? ` — ${r.summary}` : "";
      const importance = r.importance != null ? ` [importance: ${r.importance}]` : "";
      return `- [${r.id}] ${label}: ${r.title}${tail}${importance}`;
    })
    .join("\n");

  const artifact = [
    `Collection: ${fixture.input.collectionName}`,
    `Week starting (ET Monday): ${fixture.input.weekStart}`,
    `Releases:\n${releasesBlock}`,
    ``,
    `Generated title: ${result.title}`,
    `Generated intro: ${result.intro}`,
    `Generated body:\n${result.bodyRaw}`,
  ].join("\n");

  const prompt = buildGraderPrompt({
    rubric: WEEKLY_DIGEST_JUDGE_RUBRIC,
    artifact,
    rubricLabel: "weekly-digest.md",
  });

  return runJudge(model, prompt, 4096);
}

// ── Dry-run fake model (zero API cost) ──────────────────────────────────────

function fakeDigestModel(fixture: WeeklyDigestFixture): TextModel {
  const { selected } = selectWeeklyDigestReleases(fixture.input.releases);
  const cited = selected.slice(0, Math.max(MIN_PLACEHOLDERS, Math.min(4, selected.length)));
  const highImportance = fixture.input.releases.filter((r) => (r.importance ?? 0) >= 4);
  const allCited = [...new Map([...cited, ...highImportance].map((r) => [r.id, r])).values()];

  const body = [
    "### Canned dry-run section one",
    "",
    ...allCited.map(
      (r) => `${r.org} shipped [${r.title}](rel:${r.id}), a change worth a full sentence of prose.`,
    ),
    "",
    "### Canned dry-run section two",
    "",
    "A supporting paragraph of narrative prose padding out the body so the word-count grader passes cleanly without needing a real model call. ".repeat(
      16,
    ),
  ].join("\n");

  const raw = [
    `<title>Dry-run canned digest for ${fixture.input.collectionName}</title>`,
    `<intro>This is a canned dry-run intro sentence standing in for a real model response.</intro>`,
    `<body>${body}</body>`,
    `<releases>${allCited.map((r) => r.id).join(",")}</releases>`,
  ].join("\n");

  return {
    id: "dry-run:fake",
    async complete() {
      return {
        text: raw,
        usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
      };
    },
  };
}

// ── Cost tracking ────────────────────────────────────────────────────────

function estimateUsageCostUsd(modelId: string, usage: TextModelUsage): number | null {
  if (usage.costUsd != null) return usage.costUsd;
  // Anthropic ids look like "anthropic:claude-haiku-4-5" (eval label) or bare
  // "claude-haiku-4-5" — try the bare form against the pricing table.
  const bareModel = modelId.includes(":") ? modelId.split(":")[1] : modelId;
  const est = estimateCost(
    {
      inputTokens: usage.input,
      cacheWriteTokens: usage.cacheCreate,
      cacheReadTokens: usage.cacheRead,
      outputTokens: usage.output,
    },
    bareModel,
  );
  return est?.totalUsd ?? null;
}

// ── Main ───────────────────────────────────────────────────────────────────

/** `--fixtures=name1,name2` restricts the run to named fixtures — a cost-conscious
 * way to smoke-test a lane on a small sample before running the full protocol. */
function selectedFixtures(): WeeklyDigestFixture[] {
  const arg = process.argv.find((a) => a.startsWith("--fixtures="));
  if (!arg) return FIXTURES;
  const names = new Set(arg.slice("--fixtures=".length).split(",").filter(Boolean));
  return FIXTURES.filter((f) => names.has(f.name));
}

async function main() {
  const useJudge = process.argv.includes("--judge");
  const dryRun = process.argv.includes("--dry-run");
  const repeatsArg = process.argv.find((a) => a.startsWith("--repeats="));
  const repeats = repeatsArg ? Math.max(1, Number(repeatsArg.slice("--repeats=".length)) || 1) : 1;
  const fixtures = selectedFixtures();

  let digestModel: TextModel;
  if (dryRun) {
    // Model is per-fixture in dry-run (canned response references that
    // fixture's own release ids) — resolved inside the loop instead.
    digestModel = {
      id: "dry-run:fake",
      async complete() {
        throw new Error("dry-run digestModel placeholder should never be called directly");
      },
    };
  } else {
    const resolved = resolveEvalModel({
      anthropicModel: DIGEST_MODEL,
      generationName: "eval-weekly-digest",
      orModelEnvVar: "EVAL_MODEL",
      reasoning: { enabled: false },
    });
    if (!resolved) {
      console.error(
        "No ANTHROPIC_API_KEY or (OPENROUTER_API_KEY + EVAL_MODEL) set — skipping weekly-digest eval (no spend). Use --dry-run to exercise the harness for free.",
      );
      process.exit(0);
    }
    digestModel = resolved.model;
  }
  console.error(
    `model under test: ${digestModel.id}${dryRun ? " (dry-run, per-fixture canned)" : ""}`,
  );

  const judgeModel = useJudge && !dryRun ? resolveJudgeModel() : null;
  if (judgeModel) console.error(`judge model: ${judgeModel.id}`);

  let allPassed = true;
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  console.error(`\n${"=".repeat(60)}`);
  console.error(
    `Weekly-digest eval${useJudge ? " (+ judge)" : ""}${dryRun ? " [DRY RUN]" : ""}: ${fixtures.length} fixtures x ${repeats} repeat(s)`,
  );
  console.error("=".repeat(60));

  const runCases: Array<{ name: string; passed: boolean; fields: FieldResult[] }> = [];

  for (const fixture of fixtures) {
    for (let rep = 0; rep < repeats; rep++) {
      const caseName = repeats > 1 ? `${fixture.name}#${rep + 1}` : fixture.name;
      let fields: FieldResult[];
      let passed: boolean;
      const model = dryRun ? fakeDigestModel(fixture) : digestModel;
      try {
        const idToPath = new Map(
          fixture.input.releases.map((r) => [r.id, releasePath({ id: r.id, title: r.title })]),
        );
        const result = await runDigest(model, fixture.input);

        totalInputTokens += result.usage.input + result.usage.cacheCreate + result.usage.cacheRead;
        totalOutputTokens += result.usage.output;
        const costUsd = estimateUsageCostUsd(model.id, result.usage);
        if (costUsd != null) totalCostUsd += costUsd;

        // Sanity: resolving placeholders against idToPath should never throw
        // and should never surface an id outside the fixture set (belt-and-
        // braces on top of the structural grader, exercising the exact
        // production resolution path).
        resolveReleasePlaceholders(result.bodyRaw, idToPath);

        ({ fields, passed } = gradeWeeklyDigest(result, fixture));

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
            field: "runDigest throws",
            passed: false,
            expected: "no throw",
            actual: String(err),
          },
        ];
        passed = false;
      }

      allPassed = allPassed && passed;
      runCases.push({ name: caseName, passed, fields });
      console.error(`  ${passed ? "PASS" : "FAIL"}  ${caseName}`);
      for (const fld of fields) {
        if (!fld.passed) {
          console.error(
            `        ${fld.field}: expected=${JSON.stringify(fld.expected)}, actual=${JSON.stringify(fld.actual)}`,
          );
        }
      }
    }
  }

  console.error(
    `\ntotal tokens: ${totalInputTokens} in / ${totalOutputTokens} out` +
      (dryRun ? "" : ` — est. cost: $${totalCostUsd.toFixed(4)}`),
  );

  const file = saveRun({
    eval: "weekly-digest",
    model: dryRun ? "dry-run:fake" : digestModel.id,
    pass: allPassed,
    summary: {
      total: runCases.length,
      passed: runCases.filter((c) => c.passed).length,
      judge: useJudge,
      judgeModel: judgeModel?.id ?? null,
      dryRun,
      totalInputTokens,
      totalOutputTokens,
      estCostUsd: dryRun ? 0 : totalCostUsd,
    },
    cases: runCases,
  });
  console.error(`\n${allPassed ? "PASS" : "FAIL"}`);
  console.error(`results: ${file}\n`);
  process.exit(allPassed ? 0 : 1);
}

main();
