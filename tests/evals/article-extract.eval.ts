/**
 * Feed-enrichment article-extraction regression eval. LOCAL, AD-HOC ONLY — calls
 * a real provider API. Run: `bun run eval:article-extract`. Never part of
 * `bun test`.
 *
 * Default provider is Anthropic Haiku (the production baseline). To evaluate a
 * cheap OpenRouter candidate for the feed-enrich lane, set `OPENROUTER_API_KEY` +
 * `EVAL_OPENROUTER_MODEL` (e.g. `EVAL_OPENROUTER_MODEL=google/gemini-2.5-flash-lite`)
 * — the prompt + fixtures are held constant so the run is a clean cross-model
 * comparison. Optionally set `OPENROUTER_BASE_URL` to route through an AI Gateway.
 *
 * Grading is structural and deterministic (no judge model): each fixture asserts
 * body phrases that must survive VERBATIM (`mustContain` — which also catches
 * paraphrasing, since a reworded body won't contain the exact phrase) and chrome /
 * other-article phrases that must be dropped (`mustNotContain`). A JS-shell / index
 * page uses `maxChars` rather than a strict "must be empty": production discards
 * any enrichment below the thin-content floor (~200 chars), so the real
 * requirement is "don't hallucinate a substantial body from a shell", not "emit
 * exactly nothing" — a bar even Haiku doesn't clear deterministically. Likewise
 * `mustNotContain` avoids ambiguous trailing "Related:" footers, which every
 * model (Haiku included) drops inconsistently. Gate: pass iff every fixture passes.
 */
import { readFileSync, readdirSync } from "fs";
import { basename, join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { extractArticle, MODEL } from "@releases/ai-internal/article-extract";
import {
  anthropicTextModel,
  openRouterTextModel,
  type TextModel,
} from "@releases/ai-internal/text-model";
import { gradeArticle, type ArticleSpec } from "./graders";
import { saveRun } from "./results";

interface ArticleFixture {
  name: string;
  markdown: string;
  spec: ArticleSpec;
}

function loadFixtures(dir: string): ArticleFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((mdFile) => {
      const name = basename(mdFile, ".md");
      const spec = JSON.parse(
        readFileSync(join(dir, `${name}.expected.json`), "utf8"),
      ) as ArticleSpec;
      const markdown = readFileSync(join(dir, mdFile), "utf8");
      return { name, markdown, spec };
    });
}

/**
 * Build the TextModel under test. Defaults to Anthropic Haiku (production
 * baseline); when OPENROUTER_API_KEY + EVAL_OPENROUTER_MODEL are set, evaluates
 * that OpenRouter candidate against the same prompt + fixtures.
 */
function buildEvalModel(): { model: TextModel; label: string } | null {
  const orKey = process.env.OPENROUTER_API_KEY?.trim();
  const orModel = process.env.EVAL_OPENROUTER_MODEL?.trim();
  if (orKey && orModel) {
    return {
      model: openRouterTextModel({
        apiKey: orKey,
        model: orModel,
        ...(process.env.OPENROUTER_BASE_URL?.trim()
          ? { baseURL: process.env.OPENROUTER_BASE_URL.trim() }
          : {}),
        referer: "https://releases.sh",
        title: "Releases",
        // Tag eval runs so Broadcast traces stay separate from prod traffic.
        trace: { generationName: "feed-enrich-eval", environment: "eval" },
      }),
      label: `openrouter:${orModel}`,
    };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return {
      model: anthropicTextModel(new Anthropic({ apiKey }), MODEL),
      label: `anthropic:${MODEL}`,
    };
  }
  return null;
}

async function main() {
  const picked = buildEvalModel();
  if (!picked) {
    console.error(
      "No provider key set (ANTHROPIC_API_KEY, or OPENROUTER_API_KEY + EVAL_OPENROUTER_MODEL) — skipping article-extract eval (no spend).",
    );
    process.exit(0);
  }
  const { model, label } = picked;

  const dir = join(import.meta.dir, "fixtures", "articles");
  const fixtures = loadFixtures(dir);

  console.error(`\n${"=".repeat(60)}`);
  console.error(`Article-extract eval: ${fixtures.length} fixtures · model ${label}`);
  console.error("=".repeat(60));

  const cases: Array<{ name: string; passed: boolean; fields: string[] }> = [];
  for (const f of fixtures) {
    let failures: string[];
    try {
      const { content } = await extractArticle(model, {
        markdown: f.markdown,
        title: f.spec.title,
      });
      failures = gradeArticle(f.spec, content);
    } catch (err) {
      failures = [`extractArticle threw: ${String(err)}`];
    }
    const passed = failures.length === 0;
    cases.push({ name: f.name, passed, fields: failures });
    console.error(`  ${passed ? "PASS" : "FAIL"}  ${f.name}`);
    for (const msg of failures) console.error(`        ${msg}`);
  }

  const passedCount = cases.filter((c) => c.passed).length;
  const pass = passedCount === cases.length;

  console.error(`\n${pass ? "PASS" : "FAIL"} — ${passedCount}/${cases.length} fixtures\n`);

  const file = saveRun({
    eval: "article-extract",
    model: label,
    pass,
    summary: { total: cases.length, passed: passedCount },
    cases,
  });
  console.error(`results: ${file}`);

  process.exit(pass ? 0 : 1);
}

main();
