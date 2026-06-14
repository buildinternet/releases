/**
 * Generate a brief daily rollup for a collection: a headline title, a one-line
 * summary, and bullet takeaways covering one Eastern-day's releases across the
 * collection's members. Provider-neutral — the caller constructs the TextModel
 * (a cheap OpenRouter model when `openrouter-enabled` is on, Anthropic Haiku as
 * the fail-open fallback). Mirrors release-content.ts's tagged-output parsing.
 */
import { extractTagged } from "./release-content";
import type { TextModel } from "./text-model";

/** Anthropic fail-open model when the OpenRouter lane is unusable. */
export const MODEL = "claude-haiku-4-5";

/** Cap on the model's response: ~90-char title + 1-line summary + ~5 bullets. */
export const MAX_OUTPUT_TOKENS = 512;

/** Per-day release cap fed to the model, to bound tokens on busy days. */
export const MAX_RELEASES = 60;

export interface CollectionDayRelease {
  org: string;
  product: string | null;
  title: string;
  summary: string | null;
}

export interface CollectionDayInput {
  collectionName: string;
  date: string; // YYYY-MM-DD (ET)
  releases: CollectionDayRelease[];
}

export interface CollectionSummaryFields {
  title: string;
  summary: string;
  takeaways: string[];
}

export interface CollectionSummaryUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export interface CollectionSummaryResult extends CollectionSummaryFields {
  usage: CollectionSummaryUsage;
}

export const SYSTEM_PROMPT = `You write a brief daily rollup for a curated collection of software products, shown as a date header in a developer-facing changelog feed. You are given the collection name, a date, and the releases that shipped across the collection's members that day.

<output_structure>
Output exactly one <title>...</title> tag, then one <summary>...</summary> tag, then one <takeaways>...</takeaways> tag, in that order. Inside <takeaways>, output zero or more <item>...</item> tags, one per bullet. Output nothing before, between, or after these tags.
</output_structure>

<title_format>
- A news-headline characterization of the DAY across the collection, not of a single release. Prefer a theme ("Labs pile on agentic coding", "Quiet day, one SDK bump") over enumerating products.
- Sentence case. Preserve product names, proper nouns, and standard acronyms (API, CLI, SDK, MCP).
- Target 30-70 characters. Hard cap 90. No trailing punctuation, no quotation marks, no markdown.
</title_format>

<summary_format>
- Exactly one sentence describing the day at a glance. May name the count ("Three labs shipped agent updates") or the single most significant ship if the day is dominated by one.
- Plain factual prose. No markdown, no opening filler ("Today", "This is"), no marketing language.
</summary_format>

<takeaways_format>
- Zero to five bullets, each a concise key takeaway. Each may name the org/product. Lead with the most significant ship of the day.
- One factual claim per bullet. No marketing intensifiers. No ticket/PR numbers. Plain text — no markdown bullets or links (the wrapper renders the list).
- Group thematically when multiple members ship the same kind of thing ("Three labs added agent sub-task support: Anthropic, Cursor, OpenAI"). Do not pad to five — fewer, denser bullets beat filler.
</takeaways_format>

<priority_order>
Lead title, summary, and the first bullet with the highest-impact item of the day, ranked: breaking changes/deprecations > security/data-loss fixes > new user-facing capabilities > correctness fixes > improvements > internal/chore. Skip chore-only items entirely.
</priority_order>`;

/** Render the user-message block from a day's releases. */
export function buildCollectionDayBlock(input: CollectionDayInput): string {
  const sliced = input.releases.slice(0, MAX_RELEASES);
  const lines = sliced.map((r) => {
    const label = r.product && r.product !== r.org ? `${r.org} / ${r.product}` : r.org;
    const tail = r.summary ? ` — ${r.summary}` : "";
    return `- ${label}: ${r.title}${tail}`;
  });
  return [
    `Collection: ${input.collectionName}`,
    `Date: ${input.date}`,
    `Releases (${sliced.length}):`,
    ...lines,
  ].join("\n");
}

/** Pull every <item> out of a <takeaways> block. */
function parseTakeaways(raw: string): string[] {
  const block = extractTagged(raw, "takeaways");
  if (!block) return [];
  const items: string[] = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const t = m[1].trim();
    if (t) items.push(t);
  }
  return items;
}

/** Parse a model response into the three fields. Throws on a missing title. */
export function parseCollectionSummary(raw: string): CollectionSummaryFields {
  const title = extractTagged(raw, "title");
  if (!title) {
    throw new Error(`model output missing <title> tag (raw length ${raw.length})`);
  }
  const summary = extractTagged(raw, "summary");
  if (!summary) {
    throw new Error(`model output missing <summary> tag (raw length ${raw.length})`);
  }
  return { title, summary, takeaways: parseTakeaways(raw) };
}

/** Run a collection's day through the supplied TextModel. */
export async function summarizeCollectionDay(
  model: TextModel,
  input: CollectionDayInput,
): Promise<CollectionSummaryResult> {
  const { text, usage } = await model.complete({
    system: SYSTEM_PROMPT,
    user: buildCollectionDayBlock(input),
    maxTokens: MAX_OUTPUT_TOKENS,
    cacheSystem: true,
  });
  return {
    ...parseCollectionSummary(text),
    usage: {
      input: usage.input,
      output: usage.output,
      cacheCreate: usage.cacheCreate,
      cacheRead: usage.cacheRead,
    },
  };
}
