/**
 * Summary-only feed detection. A "thin" item carries no real body beyond its
 * own teaser; a feed is "summary-only" when a strong majority of a batch is
 * thin. Pure and side-effect-free so the decision matrix is unit-testable.
 */
import type { RawRelease } from "./types.js";

/** Below this many characters, an item's content is treated as a teaser. */
export const DEFAULT_FEED_THIN_CHARS = 600;

/** Minimum batch size before we trust a summary-only verdict. */
export const MIN_BATCH_FOR_ASSESSMENT = 3;

/** Fraction of thin items that flips a batch to "summary-only". */
export const SUMMARY_ONLY_THIN_RATIO = 0.6;

export interface ThinOpts {
  thinChars: number;
}

export function isThinItem(raw: RawRelease, opts: ThinOpts): boolean {
  const content = (raw.content ?? "").trim();
  if (content.length === 0) return true;
  if (raw.contentFromSummary === true) return true;
  return content.length < opts.thinChars;
}

/**
 * Pre-fetch guard on a feed item's link: returns `false` when following the URL
 * is unlikely to yield one article. Two bad shapes, both confirmed against real
 * feeds:
 *
 *  - **Anchored fragment** (`…/changelog#march-2026`) — the link targets a
 *    section of a docs page shared by every entry, so a fetch returns the whole
 *    page (nav + all sections), not one release.
 *  - **Filtered index** (`…/release-notes/?title=…`) — a listing root where the
 *    item identity rides in the query string; the page serves the entire index.
 *    Detected as a query string on a directory-style (trailing-slash) path, so a
 *    clean permalink carrying tracking params (`/blog/post?utm=…`) still passes.
 *
 * Pure and per-item. Skipping is fail-safe — the caller keeps the feed teaser —
 * so an unparseable link is treated as not enrichable rather than fetched blind.
 */
export function isEnrichableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hash.length > 0) return false;
  if (parsed.search.length > 0 && parsed.pathname.endsWith("/")) return false;
  return true;
}

/**
 * Verdict for a parsed batch. `null` means "not enough signal" — too few items
 * to trust, so callers must not flip the persisted flag.
 */
export function assessFeedDepth(
  items: readonly RawRelease[],
  opts: ThinOpts,
): "full" | "summary-only" | null {
  if (items.length < MIN_BATCH_FOR_ASSESSMENT) return null;
  const thinCount = items.filter((it) => isThinItem(it, opts)).length;
  return thinCount / items.length >= SUMMARY_ONLY_THIN_RATIO ? "summary-only" : "full";
}
