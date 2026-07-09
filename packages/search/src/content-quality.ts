/**
 * Release content-quality tiers for retrieval ranking.
 *
 * Shared by hybrid search (drop empty vectors that pollute RRF) and the
 * related-rails ranking path (hard-exclude empty neighbors). Pure — no I/O.
 *
 * History: first landed in workers/api related-ranking for rails, then
 * generalized here after prod search evals showed empty docs
 * (`langfuse:test` / title+summary "test") ranking #1 for unrelated
 * entity queries via the vector leg of hybrid fusion.
 */

export type ContentTier = "empty" | "thin" | "full";

/** Below this many chars a body is content-free regardless of wording. */
export const MIN_CONTENT_CHARS = 15;
/** A boilerplate "no changes" phrase only excludes inside a body this short. */
export const BOILERPLATE_MAX_CHARS = 120;
/** Real content below this length is "thin" — down-weighted, not excluded. */
export const THIN_CONTENT_CHARS = 160;
/** Rank multiplier applied to thin releases (related rails). */
export const THIN_WEIGHT = 0.5;

/**
 * The "no changes" family: `no … changes|updates|fixes` with any short run of
 * qualifier words in between. Only consulted for short bodies (see
 * {@link BOILERPLATE_MAX_CHARS}).
 */
const BOILERPLATE_RE = /\bno\b[\s\w,'-]{0,24}\b(?:changes?|updates?|fixes?)\b/i;

/**
 * Placeholder bodies an extractor leaves behind when it found nothing to
 * describe. Same short-body gate as {@link BOILERPLATE_RE}.
 */
const PLACEHOLDER_RE =
  /\b(?:(?:release )?notes?\s+(?:do|does)\s+not\s+describe|no\s+release\s+notes|no\s+description|no\s+notes\b|description\s+(?:unavailable|not\s+provided)|nothing\s+(?:to\s+note|noteworthy))\b/i;

/**
 * Length of a body once URLs and auto-generated scaffolding are stripped. A
 * bare GitHub "Full Changelog: <compare-url>" body has real character length
 * but no prose — this collapses it to ~0.
 */
export function meaningfulTextLength(text: string): number {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bfull\s+changelog\b/gi, " ")
    .replace(/[#*_>`~()[\]:;,.\s-]+/g, " ")
    .trim().length;
}

export interface ContentQuality {
  tier: ContentTier;
  /** Rank multiplier: empty → 0 (excluded), thin → 0.5, full → 1. */
  weight: number;
}

/**
 * Classify a release's body for retrieval eligibility. `text` is the display
 * summary (used for boilerplate matching); `contentChars` is the effective
 * body length (preferred over `text.length` when available).
 */
export function classifyContentQuality(
  text: string | null | undefined,
  contentChars: number | null | undefined,
): ContentQuality {
  const trimmed = (text ?? "").trim();
  const len = contentChars != null && contentChars > 0 ? contentChars : trimmed.length;

  if (len < MIN_CONTENT_CHARS) return { tier: "empty", weight: 0 };
  // URL- / scaffolding-only bodies have length but no prose once stripped.
  if (meaningfulTextLength(trimmed) < MIN_CONTENT_CHARS) return { tier: "empty", weight: 0 };
  // Short boilerplate / placeholder notes that carry no real content.
  if (
    len < BOILERPLATE_MAX_CHARS &&
    (BOILERPLATE_RE.test(trimmed) || PLACEHOLDER_RE.test(trimmed))
  ) {
    return { tier: "empty", weight: 0 };
  }
  if (len < THIN_CONTENT_CHARS) return { tier: "thin", weight: THIN_WEIGHT };
  return { tier: "full", weight: 1 };
}

/**
 * Prefer summary; fall back to title. Used when hydrating search hits that
 * already COALESCE(summary, content[:300]) into `summary`.
 */
export function releaseDisplayText(opts: {
  title?: string | null;
  summary?: string | null;
}): string {
  const summary = (opts.summary ?? "").trim();
  if (summary.length > 0) return summary;
  return (opts.title ?? "").trim();
}

/** True when a release should not appear in search/related candidate pools. */
export function isEmptyReleaseContent(opts: {
  title?: string | null;
  summary?: string | null;
  contentChars?: number | null;
}): boolean {
  const text = releaseDisplayText(opts);
  return classifyContentQuality(text, opts.contentChars ?? text.length).tier === "empty";
}
