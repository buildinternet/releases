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
import { extractArticle, MODEL } from "@releases/ai-internal/article-extract";
import { gradeArticle, type ArticleSpec } from "./graders";
import { resolveEvalModel } from "./judge-model";
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

async function main() {
  // The model under test: Anthropic Haiku (production baseline) by default, or an
  // OpenRouter candidate for the feed-enrich lane when OPENROUTER_API_KEY +
  // EVAL_OPENROUTER_MODEL are set. See ./judge-model.ts.
  const picked = resolveEvalModel({
    anthropicModel: MODEL,
    generationName: "feed-enrich-eval",
    orModelEnvVar: "EVAL_OPENROUTER_MODEL",
  });
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
