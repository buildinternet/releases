import { COVERAGE_COUNT_EXPR } from "@releases/core-internal/release-coverage-sql";

export type LatestReleaseRow = {
  id: string;
  version: string | null;
  title: string;
  summary: string | null;
  title_generated: string | null;
  title_short: string | null;
  published_at: string | null;
  url: string | null;
  media: string | null;
  source_slug: string;
  source_name: string;
  source_type: string;
  org_slug: string | null;
  type: string;
  coverage_count: number;
  content_chars: number | null;
  content_tokens: number | null;
};

export interface LatestReleasesFilter {
  /** Limit to a single source by id (mutually exclusive with orgId) */
  sourceId?: string;
  /** Limit to an org's sources by id (mutually exclusive with sourceId) */
  orgId?: string;
  /** Include coverage-side rows (hidden by default) */
  includeCoverage?: boolean;
  /** Include prereleases (hidden by default) */
  includePrereleases?: boolean;
  /**
   * Exclude releases whose source.type is in this list. Validated upstream
   * against the canonical `["github","scrape","feed","agent"]` set; we trust
   * the input here and bind it directly into a NOT IN clause.
   */
  excludeSourceTypes?: string[];
  /**
   * Canonical ISO bounds on `published_at` (resolved from any relative
   * shorthand upstream). `since` keeps rows at or after the bound; `until` at
   * or before. Both drop NULL-`published_at` rows.
   */
  since?: string;
  until?: string;
  limit: number;
}

export async function getLatestReleasesAcross(
  d1: D1Database,
  f: LatestReleasesFilter,
): Promise<LatestReleaseRow[]> {
  const releasesTable = f.includeCoverage ? "releases" : "releases_visible";
  const wheres: string[] = [
    "(s.is_hidden = 0 OR s.is_hidden IS NULL)",
    "(o.is_hidden = 0 OR o.is_hidden IS NULL)",
    // Drop releases whose org is soft-deleted. A tombstoned org keeps its row
    // (slug mangled to "<slug>--<id>") and its sources are normally tombstoned
    // alongside it, but the two can diverge — the sweep-tombstones cron flags
    // orgs that still have active children. `sources_active` already sheds
    // tombstoned sources; this guards the org side. On a LEFT-join miss
    // (genuine orphan source, no org row) `o.deleted_at` is NULL, so orphans
    // still pass with a NULL org_slug exactly as before.
    "(o.deleted_at IS NULL)",
    "(r.suppressed IS NULL OR r.suppressed = 0)",
  ];
  // Matches the source-feed, org-feed, and MCP `get_latest_releases` defaults
  // so every read surface returns the same canonical-only shape unless the
  // caller opts in via `?include_prereleases=true`.
  if (!f.includePrereleases) {
    wheres.push("(r.prerelease IS NULL OR r.prerelease = 0)");
  }
  const bindings: (string | number)[] = [];

  if (f.sourceId) {
    wheres.push("s.id = ?");
    bindings.push(f.sourceId);
  } else if (f.orgId) {
    wheres.push("s.org_id = ?");
    bindings.push(f.orgId);
  }

  if (f.excludeSourceTypes && f.excludeSourceTypes.length > 0) {
    const placeholders = f.excludeSourceTypes.map(() => "?").join(", ");
    wheres.push(`s.type NOT IN (${placeholders})`);
    bindings.push(...f.excludeSourceTypes);
  }

  // Time window on published_at — string comparison is correct for the ISO
  // text column, and `>=`/`<=` naturally drop NULL-dated rows.
  if (f.since) {
    wheres.push("r.published_at >= ?");
    bindings.push(f.since);
  }
  if (f.until) {
    wheres.push("r.published_at <= ?");
    bindings.push(f.until);
  }

  const whereSql = wheres.join(" AND ");
  bindings.push(f.limit);

  const stmt = d1
    .prepare(
      `
    SELECT r.id, r.version, r.title, r.summary, r.title_generated, r.title_short, r.type,
           r.published_at, r.url, r.media,
           r.content_chars, r.content_tokens,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type,
           o.slug AS org_slug,
           ${COVERAGE_COUNT_EXPR} AS coverage_count
    FROM ${releasesTable} r
    INNER JOIN sources_active s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    WHERE ${whereSql}
    ORDER BY
      CASE WHEN r.published_at IS NOT NULL THEN 0 ELSE 1 END,
      r.published_at DESC,
      r.fetched_at DESC,
      r.id DESC
    LIMIT ?
  `,
    )
    .bind(...bindings);

  const { results } = await stmt.all<LatestReleaseRow>();
  return results;
}
