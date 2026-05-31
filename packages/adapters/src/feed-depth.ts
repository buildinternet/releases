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

/**
 * Fraction of item URLs that must share the same base (scheme+host+path) AND
 * carry a `#fragment` for a batch to be classified as an anchor-fragment feed.
 * Anchored changelogs (e.g. CodeRabbit's `…/changelog#entry-slug`) resolve
 * server-side to the entire page, so the enricher can never isolate one entry.
 */
export const ANCHOR_FRAGMENT_MAJORITY = 0.6;

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
 * Returns true when a strong majority of the given URLs are anchor-fragment
 * links that all share the same base (scheme + host + path). These are
 * single-page changelogs where every entry is a `#section` on one document.
 * A server-side fetch always returns the full page — the enricher cannot
 * isolate any entry, so the source must not be treated as enrichable.
 *
 * Pure and cheap — no fetches, no regex scanning beyond `new URL`. Requires
 * at least `MIN_BATCH_FOR_ASSESSMENT` items to produce a verdict (same guard
 * as `assessFeedDepth`).
 */
export function isBatchAnchorFragment(urls: readonly string[]): boolean {
  if (urls.length < MIN_BATCH_FOR_ASSESSMENT) return false;

  // Count URLs that carry a non-empty fragment.
  const anchored: string[] = [];
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (parsed.hash.length > 1) {
        // hash includes the leading '#'; length > 1 means there is an actual fragment
        anchored.push(`${parsed.protocol}//${parsed.host}${parsed.pathname}`);
      }
    } catch {
      // skip unparseable
    }
  }

  if (anchored.length / urls.length < ANCHOR_FRAGMENT_MAJORITY) return false;

  // Check whether the anchored URLs all share a single dominant base path.
  // Build a frequency map and see if the most-common base accounts for
  // >= ANCHOR_FRAGMENT_MAJORITY of the *total* batch.
  const freq = new Map<string, number>();
  for (const base of anchored) {
    freq.set(base, (freq.get(base) ?? 0) + 1);
  }
  const maxCount = Math.max(...freq.values());
  return maxCount / urls.length >= ANCHOR_FRAGMENT_MAJORITY;
}

/**
 * Verdict for a parsed batch. `null` means "not enough signal" — too few items
 * to trust, so callers must not flip the persisted flag.
 *
 * Returns `"anchor-fragment"` when a strong majority of item URLs are
 * `#fragment` links to the same base page — enrichment cannot isolate entries
 * from such sources, so they must not be marked `summary-only`.
 */
export function assessFeedDepth(
  items: readonly RawRelease[],
  opts: ThinOpts,
): "full" | "summary-only" | "anchor-fragment" | null {
  if (items.length < MIN_BATCH_FOR_ASSESSMENT) return null;

  // Anchor-fragment check takes precedence: even if the batch is thin, we
  // must not signal "summary-only" because the enricher can't help.
  const urls = items.map((it) => it.url ?? "").filter(Boolean);
  if (isBatchAnchorFragment(urls)) return "anchor-fragment";

  const thinCount = items.filter((it) => isThinItem(it, opts)).length;
  return thinCount / items.length >= SUMMARY_ONLY_THIN_RATIO ? "summary-only" : "full";
}
