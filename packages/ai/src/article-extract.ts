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

/** Articles rarely exceed a few thousand tokens of clean body. */
export const MAX_OUTPUT_TOKENS = 4000;

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

  let content = "";
  try {
    content = extractTagged(raw, "article").trim();
  } catch {
    content = "";
  }

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
