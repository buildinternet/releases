/**
 * Per-release marketing classifier — Haiku 4.5 binary verdict on whether a
 * freshly-parsed feed item is a real product release or a marketing post
 * (customer case study, monthly newsletter, event recap, partner / cert
 * announcement, positioning piece, localized marketing variant).
 *
 * Called from the poll-fetch workflow before insert. Items the model returns
 * `<marketing>true</marketing>` for are inserted with `suppressed=true` and
 * `suppressedReason="marketing_classifier:<reason>"`, keeping them out of
 * read paths / publish / embed while preserving the row for audit and easy
 * `unsuppress`.
 *
 * Worker-safe: no `fs`, no `node:*`, no logger. The caller constructs the
 * Anthropic client (so the worker can route through AI Gateway and the script
 * path can hit the API directly), the caller decides whether the source has
 * opted in via `SourceMetadata.marketingFilter`, and the caller is responsible
 * for fail-open behavior on any thrown error.
 */

import type Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-haiku-4-5";

/** Cap on input description chars sent to the model. Feed descriptions are short
 *  (rarely > 500 chars); cap protects against the occasional outlier feed that
 *  inlines the full body. */
export const MAX_CONTENT_CHARS = 2000;

/** Cap on the model's response — verdict + short reason slug, nothing more. */
export const MAX_OUTPUT_TOKENS = 40;

/**
 * Reason slugs the model emits when `marketing=true`. Stored under
 * `suppressedReason` as `marketing_classifier:<slug>` so an operator can
 * grep / facet on the cause without re-reading every body.
 *
 * `unspecified` is the fallback when the model invented its own slug — we
 * normalize so the suppressedReason space stays tractable.
 */
export const MARKETING_REASONS = [
  "case_study",
  "newsletter",
  "event_recap",
  "partner_announcement",
  "positioning_piece",
  "localized_marketing",
  "unspecified",
] as const;
export type MarketingReason = (typeof MARKETING_REASONS)[number];

export interface MarketingClassifierInput {
  /** Human-readable source label ("ClickHouse Blog"). Anchors the model on the
   *  vendor + source kind without requiring a separate org join at call site. */
  sourceName: string;
  /** Raw feed title. */
  title: string;
  /** Feed description / content excerpt. Truncated to `MAX_CONTENT_CHARS`. */
  content: string;
  /** Item URL when present — slug shape is often the strongest tell (`/blog/<customer>`). */
  url: string | null;
  /** Optional per-source hint from `SourceMetadata.marketingFilterHint`. */
  hint?: string | null;
}

export interface MarketingClassifierUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export interface MarketingClassifierResult {
  isMarketing: boolean;
  /** A short slug. When `isMarketing=false`, callers should treat as informational only. */
  reason: MarketingReason;
  usage: MarketingClassifierUsage;
}

/**
 * The system prompt. Exported so cross-provider evaluations can hold the
 * prompt constant and vary the model.
 */
export const SYSTEM_PROMPT = `You classify changelog feed items as REAL product news or MARKETING.

This feeds a changelog index that aggregates vendor release notes for developers. Vendor blogs mix actual product news with customer case studies, newsletters, event recaps, etc.; we keep the first, drop the second.

<verdict_rule>
Return marketing=true ONLY when the item clearly fits one of these MARKETING categories:

- **case_study**: customer success story. Title patterns: "How [Company] migrated/built/cut/saved...", "Powering [X] at [Company]...", "[Company] supercharges/replaces/unifies...". URL is usually a single-word customer-name slug (/blog/chatfeatured, /blog/deshaw).
- **newsletter**: monthly / weekly digest, e.g. "April 2026 newsletter".
- **event_recap**: conference / booth presence write-up with no concrete product news ("ClickHouse at FOSDEM 2026"). If an event post announces actual product launches, that's NOT marketing — return marketing=false.
- **partner_announcement**: partner program launches, certifications, exec hires, regional GTM news, funding announcements.
- **positioning_piece**: thought-leadership without product news ("AI is reshaping the database market").
- **localized_marketing**: translation of a marketing piece (often -jp, -de, -fr URL suffixes).

Return marketing=false (real product news) for everything else, including:

- Version release notes ("ClickHouse Release 26.4", "Next.js 15.5")
- Product feature launches ("Introducing X", "X is now GA", "Announcing Y")
- Technical deep dives on a product feature ("How our query planner handles X")
- Integration announcements with concrete new product capabilities
- Benchmark / comparison posts that ship hard data
- Bug fix announcements, security advisories
</verdict_rule>

<bias>
When unsure, return marketing=false. False negatives (a marketing post slipping through) are cheaper than false positives (a real release getting hidden). Lean toward keeping.
</bias>

<output_structure>
Output exactly:

<marketing>true</marketing>
<reason>SLUG</reason>

where SLUG is one of: case_study, newsletter, event_recap, partner_announcement, positioning_piece, localized_marketing (when marketing=true) OR not_marketing (when marketing=false). Output nothing else — no prose, no explanation, no other tags.
</output_structure>`;

/**
 * Render the user message. Exported for cross-provider evaluation parity.
 */
export function buildClassifierInput(input: MarketingClassifierInput): string {
  const content =
    input.content.length > MAX_CONTENT_CHARS
      ? input.content.slice(0, MAX_CONTENT_CHARS) + "\n\n[truncated]"
      : input.content;

  const lines: (string | null)[] = [
    `Source: ${input.sourceName}`,
    `Title: ${input.title}`,
    input.url ? `URL: ${input.url}` : null,
  ];
  if (input.hint && input.hint.trim().length > 0) {
    lines.push("", `Source hint: ${input.hint.trim()}`);
  }
  lines.push("", "Content:", content);
  return lines.filter((line) => line !== null).join("\n");
}

/**
 * Pull `<marketing>true|false</marketing>` and `<reason>slug</reason>` out of
 * the model output. Throws on missing/unparseable verdict so the caller's
 * fail-open path treats it as "couldn't classify" rather than silently
 * defaulting one way.
 */
export function parseMarketingVerdict(raw: string): {
  isMarketing: boolean;
  reason: MarketingReason;
} {
  const marketingMatch = raw.match(/<marketing>\s*(true|false)\s*<\/marketing>/i);
  if (!marketingMatch) {
    throw new Error(`model output missing <marketing> tag (raw length ${raw.length})`);
  }
  const isMarketing = marketingMatch[1].toLowerCase() === "true";

  const reasonMatch = raw.match(/<reason>\s*([a-z_]+)\s*<\/reason>/i);
  const rawReason = reasonMatch?.[1]?.toLowerCase() ?? "";

  if (!isMarketing) {
    // Reason slug doesn't matter on the keep path; callers don't store it.
    return { isMarketing: false, reason: "unspecified" };
  }

  const reason = (MARKETING_REASONS as readonly string[]).includes(rawReason)
    ? (rawReason as MarketingReason)
    : "unspecified";
  return { isMarketing: true, reason };
}

/**
 * Classify a single feed item. The Anthropic client is constructed by the
 * caller so we can route through AI Gateway (worker) or hit the API directly
 * (script / eval). Throws on transport errors and on unparseable output;
 * production callers should catch and fail open (insert visibly).
 */
export async function classifyMarketing(
  client: Anthropic,
  input: MarketingClassifierInput,
): Promise<MarketingClassifierResult> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildClassifierInput(input) }],
  });

  const raw = res.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");

  const verdict = parseMarketingVerdict(raw);
  return {
    ...verdict,
    usage: {
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      cacheCreate: res.usage.cache_creation_input_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
    },
  };
}
