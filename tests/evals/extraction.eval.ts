/**
 * Extraction-quality eval (issue #1536). LOCAL, AD-HOC ONLY — calls real model
 * APIs (Anthropic + OpenRouter). Never part of `bun test`.
 *
 * Runs the production large-body extraction tool-loop (`extractWithToolsAiSdk`)
 * over the golden changelog fixtures, once per model lane, and grades each lane
 * against the fixtures' `.expected.json` with the shared field grader. The point
 * is a side-by-side, ground-truth quality number for the DeepSeek-vs-Anthropic
 * decision: is DeepSeek Pro (reasoning OFF) good enough to displace Sonnet on the
 * extraction lane before we flip `openrouter-enabled` + set EXTRACT_MODEL.
 *
 * Both lanes run through the SAME AI-SDK loop so the only variable is the model.
 *
 * Run:
 *   bun run eval:extraction                 # all lanes whose key is present
 *   ANTHROPIC_API_KEY / OPENROUTER_API_KEY gate which lanes run (missing → skipped, no spend)
 */
import { join } from "path";
import {
  extractWithToolsAiSdk,
  anthropicSpikeModel,
  type AiSdkExtractDeps,
} from "@releases/adapters/extract/aisdk";
import { buildOpenRouterExtractModel } from "@releases/adapters/extract";
import { DIRECT_FETCH_SYSTEM_PROMPT } from "@releases/adapters/extract/shared";
import {
  gradeFixture,
  loadFixtures,
  printResults,
  saveResults,
  type ActualRelease,
  type FixtureResult,
} from "./helpers";

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "changelogs");
const silentLogger = { info() {}, warn() {}, debug() {}, error() {} };

interface Lane {
  name: string;
  /** Build the AI-SDK model, or return null when the lane's key is absent. */
  model: () => AiSdkExtractDeps["model"] | null;
}

const LANES: Lane[] = [
  {
    name: "sonnet-4.6 (anthropic)",
    model: () => {
      const key = process.env.ANTHROPIC_API_KEY;
      return key ? anthropicSpikeModel({ apiKey: key, model: "claude-sonnet-4-6" }) : null;
    },
  },
  {
    name: "deepseek-v4-pro (openrouter, reasoning off)",
    model: () => {
      const key = process.env.OPENROUTER_API_KEY;
      return key
        ? buildOpenRouterExtractModel({ apiKey: key, model: "deepseek/deepseek-v4-pro" })
        : null;
    },
  },
];

async function runLane(name: string, model: AiSdkExtractDeps["model"]): Promise<FixtureResult[]> {
  const fixtures = loadFixtures(FIXTURES_DIR);
  const deps: AiSdkExtractDeps = { model, logger: silentLogger };
  const results: FixtureResult[] = [];

  for (const fx of fixtures) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential to keep token spend legible per fixture
      const r = await extractWithToolsAiSdk(
        {
          body: fx.markdown,
          systemPrompt: DIRECT_FETCH_SYSTEM_PROMPT,
          userMessage: "Extract every release entry. The body is available via the tools.",
          sourceUrl: `fixture://${fx.name}`,
          fetchUrl: `fixture://${fx.name}`,
          approxTokens: Math.round(fx.markdown.length / 4),
        },
        deps,
      );
      const actual: ActualRelease[] = r.entries.map((e) => ({
        version: e.version,
        title: e.title,
        content: e.content,
        publishedAt: e.publishedAt,
        isBreaking: e.isBreaking,
        media: e.media,
      }));
      results.push(gradeFixture(fx.name, fx.expected, actual));
    } catch (err) {
      // A loop fallback (e.g. no terminal) scores as a zero-entry fixture so the
      // lane's number reflects the failure rather than crashing the suite.
      console.error(`  [${name}] ${fx.name}: ${err instanceof Error ? err.message : String(err)}`);
      results.push(gradeFixture(fx.name, fx.expected, []));
    }
  }
  return results;
}

async function main() {
  const lanes = LANES.map((l) => ({ name: l.name, model: l.model() }));
  const active = lanes.filter((l) => l.model !== null);
  if (active.length === 0) {
    console.error("No API keys set (ANTHROPIC_API_KEY / OPENROUTER_API_KEY) — skipping, no spend.");
    return;
  }

  const summary: Array<{ lane: string; passed: number; total: number; fieldAcc: number }> = [];

  for (const lane of active) {
    // eslint-disable-next-line no-await-in-loop -- lanes run in sequence for legible cost/output
    const results = await runLane(lane.name, lane.model!);
    printResults(results, lane.name);
    saveResults(
      results,
      join(
        process.env.HOME ?? ".",
        ".releases",
        "evals",
        "results",
        `extraction-${lane.name.replace(/[^a-z0-9]+/gi, "-")}.json`,
      ),
    );
    summary.push({
      lane: lane.name,
      passed: results.filter((r) => r.passed).length,
      total: results.length,
      fieldAcc: results.reduce((s, r) => s + r.score, 0) / results.length,
    });
  }

  // Side-by-side scoreboard — the go/no-go view.
  console.error(`\n${"=".repeat(60)}\nEXTRACTION LANES — side by side\n${"=".repeat(60)}`);
  for (const s of summary) {
    console.error(
      `  ${s.lane.padEnd(42)} ${s.passed}/${s.total} fixtures | ${(s.fieldAcc * 100).toFixed(1)}% fields`,
    );
  }
  console.error("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
