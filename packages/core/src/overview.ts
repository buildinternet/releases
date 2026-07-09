import type { Kind } from "./kinds.js";
import type { Release, Source } from "./schema.js";

/**
 * Overview content is considered stale beyond this many days. CLI and MCP both
 * warn (but still show) when the overview's **content write time** is older
 * than this — prefer `updatedAt` (last amend/write), not `generatedAt` (first
 * generation, which never moves on amend). See {@link overviewContentAt}.
 */
export const OVERVIEW_STALE_DAYS = 30;

/** Default preview length when truncating overview content for inline display. */
export const OVERVIEW_PREVIEW_WORDS = 80;

/**
 * Lookback window for selecting releases to feed into overview regeneration.
 * With the daily regen cadence (#1898) a 30-day window covers active orgs.
 */
export const OVERVIEW_WINDOW_DAYS = 30;

/**
 * Fallback lookback window for quiet orgs whose 30-day slice is too thin.
 * Quiet orgs fall back to this window when the 30-day slice has fewer than
 * `OVERVIEW_MIN_WINDOW_RELEASES` releases so their overviews keep substance.
 */
export const OVERVIEW_WINDOW_FALLBACK_DAYS = 90;

/**
 * Below this many releases in the default 30-day window, widen to
 * `OVERVIEW_WINDOW_FALLBACK_DAYS` so quiet orgs still get a substantive
 * overview instead of one generated from a handful of releases.
 */
export const OVERVIEW_MIN_WINDOW_RELEASES = 5;

/** Hard cap on releases passed to the model in a single regeneration. */
export const OVERVIEW_RELEASE_LIMIT = 50;

/**
 * Per-source caps applied before the overall limit. GitHub sources ship many
 * patch bumps that otherwise crowd out higher-signal product changelogs
 * (scrape/feed) within the same org.
 */
export const PER_SOURCE_CAPS: Record<Source["type"], number> = {
  github: 10,
  scrape: 20,
  feed: 20,
  agent: 20,
  appstore: 20,
  video: 20,
};

/**
 * Per-kind family caps applied AFTER per-source caps but BEFORE the global
 * limit. Where `PER_SOURCE_CAPS` keeps a single noisy repo from dominating,
 * this keeps a whole *family* of same-kind sources from dominating: an org
 * with 10 SDK repos would otherwise feed ~100 SDK releases into the window and
 * crowd the changelog out of the model's context. Capping the SDK family
 * collectively makes it read as one prominent voice rather than N peers.
 *
 * Keyed by *resolved* kind (source.kind ?? product.kind). Kinds absent from
 * this map are uncapped at the family level. Tunable.
 */
export const PER_KIND_FAMILY_CAPS: Partial<Record<Kind, number>> = {
  sdk: 10,
};

/** Recency comparator for releases: newest first, null/empty dates sort last. */
function byRecencyDesc(a: Release, b: Release): number {
  return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
}

/** A release tagged with its owning product (null for direct org sources). */
type TaggedRelease = { release: Release; productId: string | null };

/**
 * Select releases to feed into overview regeneration. Pure: input arrays must
 * each be sorted by `publishedAt` desc; output is the merged, capped, limited,
 * resorted slice plus the pre-cap total for reporting.
 */
export function selectReleasesForOverview(
  perSource: Array<{
    type: Source["type"];
    kind?: Kind | null;
    productId?: string | null;
    releases: Release[];
  }>,
  limit: number = OVERVIEW_RELEASE_LIMIT,
): { releases: Release[]; totalAvailable: number } {
  const totalAvailable = perSource.reduce((n, s) => n + s.releases.length, 0);

  // 1. Per-source cap by adapter type (unchanged): a single noisy repo can't
  //    contribute more than its type's cap. `productId` rides along so the
  //    per-product budget (step 3) can group survivors by their owning product.
  const perSourceCapped = perSource.map(({ type, kind, productId, releases }) => ({
    kind: kind ?? null,
    productId: productId ?? null,
    releases: releases.slice(0, PER_SOURCE_CAPS[type] ?? 20),
  }));

  // 2. Per-kind family cap: pool releases of a capped kind across all its
  //    sources, keep the most-recent N. Other kinds (and untagged sources)
  //    pass through untouched. Each surviving release keeps its product tag.
  const familyPools = new Map<Kind, TaggedRelease[]>();
  const passthrough: TaggedRelease[] = [];
  for (const { kind, productId, releases } of perSourceCapped) {
    const tagged = releases.map((release) => ({ release, productId }));
    if (kind && kind in PER_KIND_FAMILY_CAPS) {
      const pool = familyPools.get(kind) ?? [];
      pool.push(...tagged);
      familyPools.set(kind, pool);
    } else {
      passthrough.push(...tagged);
    }
  }
  const familyCapped: TaggedRelease[] = [];
  for (const [kind, pool] of familyPools) {
    const cap = PER_KIND_FAMILY_CAPS[kind]!;
    const mostRecent = pool.toSorted((a, b) => byRecencyDesc(a.release, b.release)).slice(0, cap);
    familyCapped.push(...mostRecent);
  }

  // 3. Per-product budget: bucket the post-cap releases by `productId` (product-
  //    less direct sources share one "no product" bucket) and split the global
  //    limit evenly across buckets, redistributing the unused slots of any
  //    bucket holding fewer releases than its share. This stops a single
  //    high-cadence product (e.g. a daily changelog) from consuming most of the
  //    limit on recency alone. With a single bucket it is a no-op: that bucket
  //    is allotted min(limit, size), identical to the pre-budget behavior.
  const budgeted = budgetByProduct([...passthrough, ...familyCapped], limit);

  // 4. Global recency sort + global limit (the limit is a safety net; step 3
  //    already holds the total at or under `limit`).
  const sorted = budgeted.map((t) => t.release).toSorted(byRecencyDesc);
  return { releases: sorted.slice(0, limit), totalAvailable };
}

/**
 * Split `limit` slots across product buckets. Product-less releases (null
 * `productId`) share a single bucket. Each bucket gets a fair share of the
 * limit (see {@link distributeBudget}); within a bucket the most-recent
 * releases are kept. Returns the kept tagged releases; the caller does the
 * final global sort. A no-op short-circuit returns the input untouched when it
 * already fits under the limit.
 */
function budgetByProduct(tagged: TaggedRelease[], limit: number): TaggedRelease[] {
  if (tagged.length <= limit) return tagged;

  // Bucket by product, preserving first-seen order for determinism. A null
  // productId is itself the key, so all product-less direct sources collapse
  // into one shared "no product" bucket.
  const buckets = new Map<string | null, TaggedRelease[]>();
  for (const t of tagged) {
    const list = buckets.get(t.productId) ?? [];
    list.push(t);
    buckets.set(t.productId, list);
  }

  const bucketLists = [...buckets.values()].map((list) =>
    list.toSorted((a, b) => byRecencyDesc(a.release, b.release)),
  );
  const allocations = distributeBudget(
    bucketLists.map((b) => b.length),
    limit,
  );

  const kept: TaggedRelease[] = [];
  bucketLists.forEach((bucket, i) => kept.push(...bucket.slice(0, allocations[i] ?? 0)));
  return kept;
}

/**
 * Max-min fair allocation of `limit` units across buckets with the given
 * capacities. Each round splits the unallocated remainder evenly across buckets
 * that still have spare capacity; buckets that fill up release their excess into
 * the next round. Any final remainder (fewer units than still-open buckets) is
 * handed out one unit at a time to the buckets with the most spare capacity, so
 * the tail favors larger buckets rather than starving them. Total allocated ==
 * min(limit, sum(capacities)).
 *
 * e.g. distributeBudget([20, 20, 20, 15], 50) → [13, 13, 12, 12].
 */
function distributeBudget(capacities: number[], limit: number): number[] {
  const n = capacities.length;
  const alloc = Array.from<number>({ length: n }).fill(0);
  let remaining = limit;

  while (remaining > 0) {
    const open: number[] = [];
    for (let i = 0; i < n; i++) if (alloc[i] < capacities[i]) open.push(i);
    if (open.length === 0) break;
    const share = Math.floor(remaining / open.length);
    if (share === 0) break; // remainder smaller than the open-bucket count
    // Every open bucket has spare capacity and share >= 1, so each give is >= 1
    // and `remaining` strictly decreases — the loop always makes progress.
    for (const i of open) {
      const give = Math.min(share, capacities[i] - alloc[i]);
      alloc[i] += give;
      remaining -= give;
    }
  }

  // Remainder pass: fewer slots than open buckets. Give to the buckets with the
  // most spare capacity first (bucket index breaks ties for determinism).
  if (remaining > 0) {
    const order: number[] = [];
    for (let i = 0; i < n; i++) if (alloc[i] < capacities[i]) order.push(i);
    order.sort((a, b) => capacities[b] - alloc[b] - (capacities[a] - alloc[a]) || a - b);
    for (const i of order) {
      if (remaining === 0) break;
      alloc[i] += 1;
      remaining -= 1;
    }
  }

  return alloc;
}

export interface OverviewMeta {
  /** Original first write. Fixed at create; does not move on amend. */
  generatedAt: string;
  /** Last content write (initial generate or later amend). Prefer for age. */
  updatedAt?: string | null;
  lastContributingReleaseAt?: string | null;
}

/**
 * Instant that reflects when the overview *body* was last written.
 * Prefers `updatedAt` (amend/write); falls back to `generatedAt`.
 */
export function overviewContentAt(
  overview: Pick<OverviewMeta, "generatedAt" | "updatedAt">,
): string {
  return overview.updatedAt ?? overview.generatedAt;
}

/**
 * Whole-day age of an ISO timestamp. Pure math — pass content write time
 * ({@link overviewContentAt}), not raw `generatedAt`, for reader staleness.
 */
export function overviewAgeDays(contentAt: string, now: number = Date.now()): number {
  const ms = now - new Date(contentAt).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Whether a single ISO timestamp is past {@link OVERVIEW_STALE_DAYS}.
 * Pass {@link overviewContentAt}(overview) — not `generatedAt` alone —
 * when checking reader-facing content age after amends.
 */
export function isOverviewStale(contentAt: string, now: number = Date.now()): boolean {
  return overviewAgeDays(contentAt, now) > OVERVIEW_STALE_DAYS;
}

/** Age in whole days of the overview content (updatedAt, else generatedAt). */
export function overviewContentAgeDays(
  overview: Pick<OverviewMeta, "generatedAt" | "updatedAt">,
  now: number = Date.now(),
): number {
  return overviewAgeDays(overviewContentAt(overview), now);
}

/**
 * Whether the overview body is past the 30-day reader stale threshold.
 * Uses content write time, not original generation.
 */
export function isOverviewContentStale(
  overview: Pick<OverviewMeta, "generatedAt" | "updatedAt">,
  now: number = Date.now(),
): boolean {
  return isOverviewStale(overviewContentAt(overview), now);
}

/**
 * Classify an overview by its release-gap signal. The freshness gap that
 * matters for regeneration is **releases shipped since the overview was
 * last written**, not pure date diff. A 30-day-old overview with zero new
 * releases isn't actually stale; a 5-day-old overview that's missed 200
 * releases probably is.
 */
export type OverviewStaleness = "missing" | "behind" | "fresh";

export function classifyOverviewStaleness(
  hasOverview: boolean,
  releasesSinceOverview: number,
): OverviewStaleness {
  if (!hasOverview) return "missing";
  if (releasesSinceOverview > 0) return "behind";
  return "fresh";
}

/**
 * Strip a stray leading markdown heading. The overview prompt forbids
 * headings, but the model occasionally emits one anyway and it ruins
 * previews.
 */
export function stripLeadingHeading(content: string): string {
  return content.replace(/^\s*#{1,6}\s+[^\n]+\n+/, "");
}

/**
 * Shorten an overview body to a preview suitable for inline display.
 *
 * Cuts at the end of the first paragraph if it falls within `maxWords`,
 * otherwise truncates at the nearest word boundary and appends an ellipsis.
 * Leaves the input unchanged when it already fits.
 */
export function overviewPreview(
  content: string,
  maxWords: number = OVERVIEW_PREVIEW_WORDS,
): string {
  const trimmed = stripLeadingHeading(content.trim());
  if (!trimmed) return "";

  const firstParaEnd = trimmed.indexOf("\n\n");
  const firstPara = firstParaEnd === -1 ? trimmed : trimmed.slice(0, firstParaEnd);
  const firstParaWords = firstPara.split(/\s+/).length;

  if (firstParaWords <= maxWords) return firstParaEnd === -1 ? trimmed : firstPara;

  const words = trimmed.split(/\s+/);
  if (words.length <= maxWords) return trimmed;
  return words.slice(0, maxWords).join(" ") + "…";
}
