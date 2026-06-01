/**
 * Marketing-classifier regression eval. LOCAL, AD-HOC ONLY — calls the real
 * Anthropic API. Run: `bun run eval:marketing`. Never part of `bun test`.
 *
 * Gate: pass iff accuracy >= ACCURACY_FLOOR AND falsePositives <= MAX_FALSE_POSITIVES.
 * A false positive = a real release misclassified as marketing (it would be
 * hidden), which the classifier prompt explicitly treats as the costly error.
 */
import { readFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import {
  classifyMarketing,
  MODEL,
  type MarketingClassifierInput,
} from "@releases/ai-internal/marketing-classifier";
import { gradeBinary, type BinaryCase, type BinaryPrediction } from "./graders";
import { saveRun } from "./results";

const ACCURACY_FLOOR = 0.85; // headroom for 1-run noise across the fixture set
const MAX_FALSE_POSITIVES = 0; // no real release should be hidden
const RUNS_PER_CASE = 1; // raise + majority-vote as the fixture set grows

interface MarketingFixture {
  id: string;
  input: MarketingClassifierInput;
  expected: { isMarketing: boolean; reason?: string };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — skipping marketing eval (no spend).");
    process.exit(0);
  }

  const dir = join(import.meta.dir, "fixtures", "marketing");
  const fixtures = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as MarketingFixture[];
  const client = new Anthropic({ apiKey });

  const cases: BinaryCase[] = [];
  const predictions: BinaryPrediction[] = [];

  for (const f of fixtures) {
    cases.push({ id: f.id, expected: f.expected.isMarketing });
    const votes: boolean[] = [];
    for (let i = 0; i < RUNS_PER_CASE; i++) {
      const r = await classifyMarketing(client, f.input);
      votes.push(r.isMarketing);
    }
    const trueVotes = votes.filter(Boolean).length;
    predictions.push({ id: f.id, predicted: trueVotes * 2 > votes.length });
  }

  const result = gradeBinary(cases, predictions);
  const pass = result.accuracy >= ACCURACY_FLOOR && result.falsePositives <= MAX_FALSE_POSITIVES;

  console.error(`\n${"=".repeat(60)}`);
  console.error(
    `Marketing classifier: ${result.correct}/${result.total} correct (${(result.accuracy * 100).toFixed(1)}%)`,
  );
  console.error(
    `  false positives (real release hidden): ${result.falsePositives}  [max ${MAX_FALSE_POSITIVES}]`,
  );
  console.error(`  false negatives (marketing kept):      ${result.falseNegatives}`);
  console.error("=".repeat(60));
  for (const c of result.perCase) {
    if (!c.passed) {
      console.error(
        `  FAIL ${c.id}: expected ${c.expected ? "marketing" : "real"}, got ${c.predicted ? "marketing" : "real"}`,
      );
    }
  }
  console.error(
    `\n${pass ? "PASS" : "FAIL"} (floor ${ACCURACY_FLOOR}, max FP ${MAX_FALSE_POSITIVES})\n`,
  );

  const file = saveRun({
    eval: "marketing",
    model: MODEL,
    pass,
    summary: {
      accuracy: result.accuracy,
      correct: result.correct,
      total: result.total,
      falsePositives: result.falsePositives,
      falseNegatives: result.falseNegatives,
      gate: { floor: ACCURACY_FLOOR, maxFalsePositives: MAX_FALSE_POSITIVES },
    },
    cases: result.perCase,
  });
  console.error(`results: ${file}`);

  process.exit(pass ? 0 : 1);
}

main();
