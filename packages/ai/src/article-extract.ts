/**
 * Single-article extraction — turn the markdown of one web page into the clean,
 * verbatim main article body, dropping nav / sidebars / footers / "more posts"
 * lists. Used by feed enrichment when a summary-only feed item's full content
 * lives at its link. Worker-safe: caller constructs the Anthropic client.
 *
 * Deliberately NOT the multi-entry extractor (`@releases/adapters/extract`) —
 * this is one known article, so a single one-shot text call with a verbatim
 * (extract-not-rewrite) instruction is cheaper and higher-fidelity.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { extractTagged } from "./release-content";

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

export interface ArticleExtractUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

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
  client: Anthropic,
  args: { markdown: string; title: string; model?: string },
): Promise<{ content: string; usage: ArticleExtractUsage }> {
  const res = await client.messages.create({
    model: args.model ?? MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: buildArticleInput({ markdown: args.markdown, title: args.title }) },
    ],
  });

  const raw = res.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  const content = parseArticleResponse(raw);

  return {
    content,
    usage: {
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      cacheCreate: res.usage.cache_creation_input_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
    },
  };
}
