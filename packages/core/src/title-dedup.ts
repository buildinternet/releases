/**
 * Title-based dedup for scrape ingest (#1410).
 *
 * Scrape releases are stored with a synthesized anchor URL (`<page>#<slug>`), and
 * the slug differs between write paths: a local backfill anchors off the section
 * heading (`#may-2026`) while the steady-state cron's `mapEntries()` anchors off
 * `slug(version??title)`. Two anchors for the same entry don't collide under
 * `UNIQUE(source_id, url)`, so the same release lands twice. A normalized-title
 * key is the discriminator that survives the anchor mismatch (and trivial
 * case/whitespace rewordings). Scrape-scoped — feed/github/appstore carry stable
 * real URLs and must NOT be title-collapsed.
 */

/**
 * Canonical key for matching "the same release" across anchor URLs. Conservative
 * on purpose — lowercase + collapsed whitespace only — so genuinely distinct
 * releases aren't merged; a semantic reword yields a different key (inherent).
 */
export function normalizeTitleKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Drop items that duplicate an existing entry under a DIFFERENT anchor URL, by
 * normalized title (or repeat earlier in the same batch). Items with no usable
 * title are kept (can't match).
 *
 * Crucially URL-aware: an item whose `url` is already stored (`existingUrls`) is
 * NEVER pre-dropped — that's a same-row re-fetch handled by the
 * `UNIQUE(source_id, url)` upsert/conflict path, and pre-dropping it would skew
 * that path's found/inserted accounting. The title key only fires for a NEW url
 * whose title matches an existing row — exactly the cross-anchor dup this targets
 * (a backfill's `#may-2026` vs a re-fetch's `#slug(title)`).
 *
 * Generic over any item carrying `title`/`url`, so the same filter runs on the
 * parsed `RawRelease` cron path and the `/releases/batch` payload shape.
 */
export function dedupeByExistingTitle<T extends { title?: string | null; url?: string | null }>(
  items: T[],
  existingTitleKeys: Iterable<string>,
  existingUrls: Iterable<string> = [],
): { kept: T[]; dropped: number } {
  const titleKeys = new Set(existingTitleKeys);
  const urls = new Set(existingUrls);
  const seenTitles = new Set<string>();
  const kept: T[] = [];
  let dropped = 0;
  for (const item of items) {
    const url = item && typeof item.url === "string" ? item.url : "";
    if (url && urls.has(url)) {
      kept.push(item); // existing URL → let the UNIQUE(source_id,url) path handle it
      continue;
    }
    const key = normalizeTitleKey(item && typeof item.title === "string" ? item.title : "");
    if (!key) {
      kept.push(item);
      continue;
    }
    if (titleKeys.has(key) || seenTitles.has(key)) {
      dropped++;
      continue;
    }
    seenTitles.add(key);
    kept.push(item);
  }
  return { kept, dropped };
}
