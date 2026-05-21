import type { Kind } from "./kinds.js";
import type { Release, Source } from "./schema.js";

/**
 * Overview is considered stale beyond this many days. CLI and MCP both warn
 * (but still show) when an overview's `generatedAt` is older than this.
 */
export const OVERVIEW_STALE_DAYS = 30;

/** Default preview length when truncating overview content for inline display. */
export const OVERVIEW_PREVIEW_WORDS = 80;

/** Lookback window for selecting releases to feed into overview regeneration. */
export const OVERVIEW_WINDOW_DAYS = 90;

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

/**
 * Select releases to feed into overview regeneration. Pure: input arrays must
 * each be sorted by `publishedAt` desc; output is the merged, capped, limited,
 * resorted slice plus the pre-cap total for reporting.
 */
export function selectReleasesForOverview(
  perSource: Array<{ type: Source["type"]; kind?: Kind | null; releases: Release[] }>,
  limit: number = OVERVIEW_RELEASE_LIMIT,
): { releases: Release[]; totalAvailable: number } {
  const totalAvailable = perSource.reduce((n, s) => n + s.releases.length, 0);

  // 1. Per-source cap by adapter type (unchanged): a single noisy repo can't
  //    contribute more than its type's cap.
  const perSourceCapped = perSource.map(({ type, kind, releases }) => ({
    kind: kind ?? null,
    releases: releases.slice(0, PER_SOURCE_CAPS[type] ?? 20),
  }));

  // 2. Per-kind family cap: pool releases of a capped kind across all its
  //    sources, keep the most-recent N. Other kinds (and untagged sources)
  //    pass through untouched.
  const familyPools = new Map<Kind, Release[]>();
  const passthrough: Release[] = [];
  for (const { kind, releases } of perSourceCapped) {
    if (kind && kind in PER_KIND_FAMILY_CAPS) {
      const pool = familyPools.get(kind) ?? [];
      pool.push(...releases);
      familyPools.set(kind, pool);
    } else {
      passthrough.push(...releases);
    }
  }
  const familyCapped: Release[] = [];
  for (const [kind, pool] of familyPools) {
    const cap = PER_KIND_FAMILY_CAPS[kind]!;
    const mostRecent = pool
      .toSorted((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
      .slice(0, cap);
    familyCapped.push(...mostRecent);
  }

  // 3. Merge, global recency sort, global limit (unchanged semantics).
  const sorted = [...passthrough, ...familyCapped].toSorted((a, b) =>
    (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
  );
  return { releases: sorted.slice(0, limit), totalAvailable };
}

export interface OverviewMeta {
  generatedAt: string;
  updatedAt?: string | null;
  lastContributingReleaseAt?: string | null;
}

export function overviewAgeDays(generatedAt: string, now: number = Date.now()): number {
  const ms = now - new Date(generatedAt).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

export function isOverviewStale(generatedAt: string, now: number = Date.now()): boolean {
  return overviewAgeDays(generatedAt, now) > OVERVIEW_STALE_DAYS;
}

/**
 * Classify an overview by its release-gap signal. The freshness gap that
 * matters for regeneration is **releases shipped since the overview was
 * generated**, not pure date diff. A 30-day-old overview with zero new
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
