/**
 * Single-article extraction — turn the markdown of one web page into the clean,
 * verbatim main article body, dropping nav / sidebars / footers / "more posts"
 * lists. Used by feed enrichment when a summary-only feed item's full content
 * lives at its link.
 *
 * Worker-safe: the caller constructs the `TextModel` (so the worker can route
 * the lane through AI Gateway Haiku or a cheap OpenRouter model behind the
 * `openrouter-enabled` switch, while the eval / script path hits a provider
 * directly) — exactly like the `classifyMarketing` / `summarizeRelease` siblings.
 *
 * Deliberately NOT the multi-entry extractor (`@releases/adapters/extract`) —
 * this is one known article, so a single one-shot text call with a verbatim
 * (extract-not-rewrite) instruction is cheaper and higher-fidelity.
 */
import { extractTagged } from "./release-content";
import type { TextModel, TextModelUsage } from "./text-model";

/** Anthropic default the caller builds the fallback `TextModel` from. The async
 *  Message-Batches enrichment path (`enrich-apply.ts`) also reuses it directly —
 *  OpenRouter has no Batches API, so that 50%-off lane stays on Anthropic. */
export const MODEL = "claude-haiku-4-5";

/** Cap on page markdown sent to the model. Article pages are small; this guards
 *  against the occasional page that inlines a huge nav tree or comment thread. */
export const MAX_INPUT_CHARS = 60_000;

/** Output ceiling for the verbatim article body. Most articles fit easily, but
 *  long monthly changelog / patch-notes pages (e.g. Discord) can run tens of
 *  thousands of characters; 8192 tokens (~32K chars) covers the common cases.
 *  Anything still longer is handled by the truncation salvage in `extractArticle`
 *  rather than being discarded. */
export const MAX_OUTPUT_TOKENS = 8192;

/** Per-call token usage from one extraction. Alias of the seam's `TextModelUsage`
 *  — the `TextModel` now owns this shape (and carries OpenRouter's reported
 *  `costUsd`); kept as a named export for the feed-enrich call sites. */
export type ArticleExtractUsage = TextModelUsage;

export const SYSTEM_PROMPT = `You extract the main article body from the markdown of a single web page.

The page is one changelog / release-note / product-update article. Its markdown also contains page chrome: top nav, breadcrumbs, sidebars, cookie banners, newsletter sign-ups, footers, and lists of OTHER articles ("more updates", "related posts"). Your job is to return ONLY the body of the one article named by the title.

<rules>
- Output the article body VERBATIM as markdown. Do NOT summarize, paraphrase, translate, or reorder. Preserve headings, lists, code blocks, and inline links exactly.
- Drop all page chrome and any list of other articles. If a "more updates" list would pull in other releases' text, exclude it.
- Keep images that are part of the article body (markdown image syntax).
- If the page has no recognizable article body (e.g. it's a JS shell or an index page), output an empty <article></article>.
</rules>

<output_structure>
Output exactly:

<article>
...the article body as verbatim markdown...
</article>

Output nothing else — no preamble, no explanation, no other tags.
</output_structure>`;

export function buildArticleInput(args: { markdown: string; title: string }): string {
  const md =
    args.markdown.length > MAX_INPUT_CHARS
      ? args.markdown.slice(0, MAX_INPUT_CHARS) + "\n\n[truncated]"
      : args.markdown;
  return `Article title: ${args.title}\n\nPage markdown:\n${md}`;
}

/**
 * Turn the model's raw text response into the article body. Shared by the
 * synchronous `extractArticle` one-shot and the async Message Batches enrichment
 * path so both apply identical parse + salvage semantics.
 *
 * - Normal case: the trimmed content of the `<article>…</article>` pair.
 * - JS-shell / index signal: an explicit empty `<article></article>` (closing
 *   tag present) stays empty — the caller's cue the page had no real body.
 * - Truncation salvage: a long article can exhaust the output token cap before
 *   the model emits the closing `</article>`, so the strict pair-match returns
 *   "" and would discard a full body of good content. When the opening tag is
 *   present but the closing one never arrived, keep the emitted prefix — a
 *   partial body still clears the enrichment improvement bar, where "" never
 *   could.
 */
export function parseArticleResponse(raw: string): string {
  let content = extractTagged(raw, "article").trim();
  if (!content && !/<\/article>/i.test(raw)) {
    const open = raw.match(/<article>([\s\S]*)/i);
    if (open) content = open[1].trim();
  }
  return content;
}

export async function extractArticle(
  model: TextModel,
  args: { markdown: string; title: string },
): Promise<{ content: string; usage: ArticleExtractUsage }> {
  const { text: raw, usage } = await model.complete({
    system: SYSTEM_PROMPT,
    user: buildArticleInput({ markdown: args.markdown, title: args.title }),
    maxTokens: MAX_OUTPUT_TOKENS,
    cacheSystem: true,
  });

  return { content: parseArticleResponse(raw), usage };
}
