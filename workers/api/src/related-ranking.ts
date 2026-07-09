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
 *     neighbors to the top. Classifier lives in `@releases/search/content-quality`
 *     (shared with hybrid search).
 *   - Recency (`recencyMultiplier`): an exponential decay so fresh matches
 *     outrank stale ones at equal cosine similarity.
 *
 * Everything is a pure function of its inputs (recency takes an explicit
 * `now`) so the whole ranking path is unit-testable without Vectorize or D1.
 */

import { classifyContentQuality, type ContentTier } from "@releases/search/content-quality";

export type { ContentTier, ContentQuality } from "@releases/search/content-quality";
export {
  classifyContentQuality,
  MIN_CONTENT_CHARS,
  BOILERPLATE_MAX_CHARS,
  THIN_CONTENT_CHARS,
  THIN_WEIGHT,
} from "@releases/search/content-quality";

/** A 45-day-old release is worth half a same-day one at equal cosine score. */
export const RELATED_RECENCY_HALF_LIFE_DAYS = 45;
/** Multiplier for items with no usable date — kept eligible but demoted. */
export const RELATED_UNDATED_PENALTY = 0.25;

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
