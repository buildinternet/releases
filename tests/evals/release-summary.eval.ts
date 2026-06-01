/**
 * Release-summary regression eval. LOCAL, AD-HOC ONLY — calls the real Anthropic
 * API. Run: `bun run eval:summary` (Tier-1 structural) or `bun run eval:summary -- --judge`
 * (adds the Sonnet faithfulness check). Never part of `bun test`.
 */
import { readFileSync, readdirSync } from "fs";
import { basename, join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import {
  summarizeRelease,
  EMPTY_BODY_FALLBACK,
  type SummarizeReleaseInput,
} from "@releases/ai-internal/release-content";
import { buildGraderPrompt } from "@releases/ai-internal/grader-prompt";
import { gradeStructural, type StructuralSpec } from "./graders";
import type { FieldResult } from "./helpers";

const TITLE_SHORT_MAX_CHARS = 120;
const JUDGE_MODEL = "claude-sonnet-4-6";

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
  client: Anthropic,
  rubric: string,
  body: string,
  summary: string,
): Promise<boolean> {
  const prompt = buildGraderPrompt({
    rubric,
    artifact: `BODY:\n${body}\n\nSUMMARY:\n${summary}`,
    rubricLabel: "release-summary.md",
  });
  const res = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = res.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    return JSON.parse(raw).result === "satisfied";
  } catch {
    return false;
  }
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
  const client = new Anthropic({ apiKey });
  const rubric = useJudge
    ? readFileSync(
        join(import.meta.dir, "..", "..", "src", "shared", "rubrics", "release-summary.md"),
        "utf8",
      )
    : "";

  let allPassed = true;
  console.error(`\n${"=".repeat(60)}`);
  console.error(`Release summary eval${useJudge ? " (+ judge)" : ""}: ${fixtures.length} fixtures`);
  console.error("=".repeat(60));

  for (const f of fixtures) {
    let fields: FieldResult[];
    let passed: boolean;
    try {
      const result = await summarizeRelease(client, f.input);
      ({ fields, passed } = gradeStructural(f.spec, result, {
        titleShortMaxChars: TITLE_SHORT_MAX_CHARS,
        extraForbidden: [EMPTY_BODY_FALLBACK],
      }));

      if (useJudge && !f.spec.expectDiscarded && result.summary) {
        const ok = await judge(client, rubric, f.input.content, result.summary);
        fields = [
          ...fields,
          {
            field: "judge: satisfied",
            passed: ok,
            expected: "satisfied",
            actual: ok ? "satisfied" : "not satisfied",
          },
        ];
        passed = passed && ok;
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
    console.error(`  ${passed ? "PASS" : "FAIL"}  ${f.name}`);
    for (const fld of fields) {
      if (!fld.passed) {
        console.error(
          `        ${fld.field}: expected=${JSON.stringify(fld.expected)}, actual=${JSON.stringify(fld.actual)}`,
        );
      }
    }
  }

  console.error(`\n${allPassed ? "PASS" : "FAIL"}\n`);
  process.exit(allPassed ? 0 : 1);
}

main();
