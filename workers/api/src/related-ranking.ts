/**
 * Pure ranking helpers for the related-content rails (`/v1/related/*`).
 *
 * The endpoint pulls semantic neighbors from Vectorize, then ranks them here
 * before slicing — biasing toward (a) recent releases and (b) releases that
 * carry real content. Two levers:
 *
 *   - Content quality (`classifyContentQuality`): hard-excludes truly empty /
 *     boilerplate "no changes" releases and soft-down-weights short-but-real
 *     ones, so a content-free anchor can't drag a rail full of "no changes"
 *     neighbors to the top.
 *   - Recency (`recencyMultiplier`): an exponential decay so fresh matches
 *     outrank stale ones at equal cosine similarity.
 *
 * Everything is a pure function of its inputs (recency takes an explicit
 * `now`) so the whole ranking path is unit-testable without Vectorize or D1.
 */

export type ContentTier = "empty" | "thin" | "full";

/** A 45-day-old release is worth half a same-day one at equal cosine score. */
export const RELATED_RECENCY_HALF_LIFE_DAYS = 45;
/** Multiplier for items with no usable date — kept eligible but demoted. */
export const RELATED_UNDATED_PENALTY = 0.25;

/** Below this many chars a body is content-free regardless of wording. */
export const MIN_CONTENT_CHARS = 15;
/** A boilerplate "no changes" phrase only excludes inside a body this short. */
export const BOILERPLATE_MAX_CHARS = 120;
/** Real content below this length is "thin" — down-weighted, not excluded. */
export const THIN_CONTENT_CHARS = 160;
/** Rank multiplier applied to thin releases. */
export const THIN_WEIGHT = 0.5;

/**
 * Minimum combined rank (`cosine × recency × contentWeight`) a candidate must
 * clear to appear on the GLOBAL "From other products" rail. A thin anchor's
 * only semantically-similar global neighbors are maintenance/version-bump
 * releases; once the recent content-free ones are dropped, what remains is
 * stale, and its best match falls below this — so the rail collapses rather
 * than render months-old filler. Calibrated against prod: strong rails top out
 * ~0.45–0.7, the stale v2.1.150 rail topped ~0.14. NOT applied to the org rail,
 * where a slow-moving org's older releases are still its best content.
 */
export const RELATED_GLOBAL_MIN_RANK = 0.2;

const DAY_MS = 86_400_000;

/**
 * The "no changes" family: `no … changes|updates|fixes` with any short run of
 * qualifier words in between, so it catches "no changes", "no user-facing
 * changes", and "no code changes" alike. Only consulted for short bodies (see
 * {@link BOILERPLATE_MAX_CHARS}) — the bounded gap plus the length gate keep a
 * rich release that merely mentions "no breaking changes" from being excluded.
 */
const BOILERPLATE_RE = /\bno\b[\s\w,'-]{0,24}\b(?:changes?|updates?|fixes?)\b/i;

/**
 * Placeholder bodies an extractor leaves behind when it found nothing to
 * describe ("release notes do not describe the change", "no description").
 * Same short-body gate as {@link BOILERPLATE_RE}.
 */
const PLACEHOLDER_RE =
  /\b(?:(?:release )?notes?\s+(?:do|does)\s+not\s+describe|no\s+release\s+notes|no\s+description|no\s+notes\b|description\s+(?:unavailable|not\s+provided)|nothing\s+(?:to\s+note|noteworthy))\b/i;

/**
 * Length of a body once URLs and auto-generated scaffolding are stripped. A
 * bare GitHub "Full Changelog: <compare-url>" body has real character length
 * but no prose, so it would otherwise pass the length gate — this collapses it
 * to ~0. Markdown punctuation is dropped too so the residual is just words.
 */
function meaningfulTextLength(text: string): number {
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
 * Classify a release's body for rail eligibility. `text` is the display
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
 * Exponential recency decay: `0.5^(ageDays / halfLife)`. Future dates clamp to
 * 1.0; missing or unparseable dates return the undated penalty so they stay
 * eligible but can't dominate a rail.
 */
export function recencyMultiplier(
  date: string | null | undefined,
  now: number,
  halfLifeDays: number = RELATED_RECENCY_HALF_LIFE_DAYS,
  undatedPenalty: number = RELATED_UNDATED_PENALTY,
): number {
  if (!date) return undatedPenalty;
  const ms = Date.parse(date);
  if (!Number.isFinite(ms)) return undatedPenalty;
  const ageDays = Math.max(0, (now - ms) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export interface ReleaseRankInput {
  /** Vectorize cosine similarity. */
  score: number;
  publishedAt: string | null;
  /** Display summary (COALESCE of summary / content slice). */
  summary: string | null;
  /** Effective body length. */
  contentChars: number | null;
}

/**
 * Composed per-release rank used to order the `/v1/related/releases` response:
 * `cosine × recency × contentWeight`. Returns the content `tier` too so the
 * caller can drop `empty` candidates before sorting.
 */
export function scoreRelatedRelease(
  input: ReleaseRankInput,
  now: number,
): { tier: ContentTier; rank: number } {
  const quality = classifyContentQuality(input.summary, input.contentChars);
  const rank = input.score * recencyMultiplier(input.publishedAt, now) * quality.weight;
  return { tier: quality.tier, rank };
}
