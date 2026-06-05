/**
 * Org-overview regression eval. LOCAL, AD-HOC ONLY — calls the real Anthropic
 * API. Run: `bun run eval:overview` (Tier-1 structural + citation integrity) or
 * `bun run eval:overview -- --judge` (adds the Sonnet rubric faithfulness check
 * against src/shared/rubrics/overview.md). Never part of `bun test`.
 *
 * Each fixture is a single JSON file under fixtures/overviews/ carrying the
 * OverviewRequestInput the production batch-overview workflow would build, plus
 * optional per-fixture grading knobs. The eval exercises the exact production
 * path: buildOverviewRequest → messages.create → extractOverviewBody →
 * clampCitationsToBody, then grades the body and the emitted citations.
 */
import { readFileSync } from "fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildOverviewRequest,
  MODEL,
  type OverviewRequestInput,
} from "@releases/ai-internal/overview-content";
import {
  extractOverviewBody,
  clampCitationsToBody,
} from "@releases/ai-internal/overview-citations";
import { buildGraderPrompt } from "@releases/ai-internal/grader-prompt";
import { gradeOverviewStructural, gradeCitations } from "./graders";
import { loadOverviewFixtures, overviewRubricPath } from "./overview-fixtures";
import type { FieldResult } from "./helpers";
import { saveRun } from "./results";

const JUDGE_MODEL = "claude-sonnet-4-6";

/** The citation source set the API can legitimately resolve to (matches buildReleaseBlock). */
function validSources(input: OverviewRequestInput): string[] {
  return input.selected.map((r) => r.url ?? `release://${r.id}`);
}

async function judge(
  client: Anthropic,
  rubric: string,
  body: string,
): Promise<{ ok: boolean; result: string }> {
  const prompt = buildGraderPrompt({ rubric, artifact: body, rubricLabel: "overview.md" });
  // The rubric has ~24 criteria, each with an evidence quote, so the JSON
  // verdict runs well past 2K tokens; a low cap truncates it to invalid JSON
  // and every fixture scores "unparseable". 8K leaves comfortable headroom.
  const res = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = res.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    const result = String(JSON.parse(raw).result ?? "failed");
    return { ok: result === "satisfied", result };
  } catch {
    return { ok: false, result: "unparseable" };
  }
}

async function main() {
  const useJudge = process.argv.includes("--judge");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — skipping overview eval (no spend).");
    process.exit(0);
  }

  const fixtures = loadOverviewFixtures();
  const client = new Anthropic({ apiKey });
  const rubric = useJudge ? readFileSync(overviewRubricPath(), "utf8") : "";

  let allPassed = true;
  console.error(`\n${"=".repeat(60)}`);
  console.error(`Org overview eval${useJudge ? " (+ judge)" : ""}: ${fixtures.length} fixtures`);
  console.error("=".repeat(60));

  const runCases: Array<{ name: string; passed: boolean; fields: FieldResult[]; body?: string }> =
    [];

  for (const f of fixtures) {
    let fields: FieldResult[];
    let passed: boolean;
    let body: string | undefined;
    try {
      const request = buildOverviewRequest(f.input);
      const message = await client.messages.create(request);
      const extraction = extractOverviewBody(message);
      body = extraction.body;
      const citations = clampCitationsToBody(extraction.body, extraction.citations);

      const structural = gradeOverviewStructural(body, {
        orgName: f.input.org.name,
        ...f.structural,
      });
      const citationGrade = gradeCitations(body, citations, validSources(f.input), f.citations);
      fields = [...structural.fields, ...citationGrade.fields];
      passed = structural.passed && citationGrade.passed;

      if (useJudge && body.trim().length > 0) {
        const verdict = await judge(client, rubric, body);
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
    model: MODEL,
    pass: allPassed,
    summary: {
      total: runCases.length,
      passed: runCases.filter((c) => c.passed).length,
      judge: useJudge,
      judgeModel: useJudge ? JUDGE_MODEL : null,
    },
    cases: runCases,
  });
  console.error(`\n${allPassed ? "PASS" : "FAIL"}`);
  console.error(`results: ${file}\n`);
  process.exit(allPassed ? 0 : 1);
}

main();
