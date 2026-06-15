/**
 * Generate a brief daily rollup for a collection: a headline title, a one-line
 * summary, and bullet takeaways covering one Eastern-day's releases across the
 * collection's members. Provider-neutral — the caller constructs the TextModel
 * (a cheap OpenRouter model when `openrouter-enabled` is on, Anthropic Haiku as
 * the fail-open fallback). Mirrors release-content.ts's tagged-output parsing.
 */
import { extractTagged } from "./release-content";
import type { TextModel } from "./text-model";

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

export const SYSTEM_PROMPT = `You write a brief daily rollup for a curated collection of software products, shown as a date header in a developer-facing changelog feed. You are given the collection name, a date, and the releases that shipped across the collection's members that day. Write release notes, not a changelog: lead with what changed for users, and treat version numbers as supporting detail — never as the subject.

<output_structure>
Output exactly one <title>...</title> tag, then one <summary>...</summary> tag, then one <takeaways>...</takeaways> tag, in that order. Inside <takeaways>, output zero or more <item>...</item> tags, one per bullet. Output nothing before, between, or after these tags.
</output_structure>

<consolidate_by_product>
Group the day's releases by product BEFORE writing, and collapse each product's releases into its net change for the day. NEVER enumerate by version or by release — "Claude Code v2.1.175 enforces models" + "Claude Code v2.1.176 caches credentials" as two bullets is WRONG. One bullet per product is the default; use a second bullet only for a genuinely distinct, significant change (not to itemize versions). Fold an SDK family that bumped many packages (e.g. twenty @clerk/* releases) into a single bullet describing the real API change, not the package list.
</consolidate_by_product>

<skip_noise>
Skip releases with no user-facing change: dependency bumps, internal tooling / build-pipeline changes, checksum or patch-only releases, and version-only entries with no summary. If a product's only releases that day are this kind of noise, omit the product entirely. Never invent substance for a release that has none — a bare "fixes and improvements" bullet is worse than no bullet.
</skip_noise>

<priority_order>
Rank what to lead with and what to cut: breaking changes/deprecations > security or data-loss fixes > new user-facing capabilities > notable correctness fixes > minor improvements > internal/chore (skip). The title, summary, and first bullet all lead with the highest-impact change of the day.
</priority_order>

<title_format>
- A news-headline characterization of the DAY across the collection, not of one release. Prefer a theme ("Labs pile on agentic coding", "Quiet day, one SDK bump") over enumerating products or counts.
- Sentence case. Preserve product names, proper nouns, and standard acronyms (API, CLI, SDK, MCP). Do NOT put a version number in the title.
- Target 30-70 characters. Hard cap 90. No trailing punctuation, no quotation marks, no markdown.
</title_format>

<summary_format>
- Exactly one sentence describing the day at a glance, leading with the most significant change. Name the substance, not the count: "Claude Code gained managed-model enforcement while Devin added Slack-triggered sessions" — NOT "Anthropic released three updates".
- Plain factual prose. No markdown, no opening filler ("Today", "This is"), no marketing language. Do not merely restate the title.
</summary_format>

<takeaways_format>
- Zero to five bullets. Name the product as the actor and the change as the substance: "Claude Code now restricts which models are available via managed settings". Do NOT lead with or foreground a version number — "Next.js v16.3.0-canary.51 prevents a fallback flash" should read "Next.js fixes a premature Suspense fallback flash in dev". A version may appear as a trailing aside at most, never as the subject.
- Drop a redundant org prefix when the product name already identifies it: write "Claude Code", not "Anthropic Claude Code". Name the org only to disambiguate.
- One product per bullet (see consolidate_by_product); one factual claim per bullet. Keep bullets tight — roughly one line (~30 words). Consolidating means leading with the most important change, not chaining every detail with "and … and". No ticket/PR numbers, no marketing intensifiers. Plain text — no markdown bullets or links (the wrapper renders the list).
- When several products ship the same KIND of thing, group them into one bullet ("Cursor, Windsurf, and Copilot all added background agents"). Fewer, denser bullets beat padding to five.
- On a quiet day, do not repeat across layers: if a single release carries the day, let the title and summary state it and leave takeaways empty rather than restating it a third time.
</takeaways_format>`;

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
