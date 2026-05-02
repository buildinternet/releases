export type LatestReleaseRow = {
  id: string;
  version: string | null;
  title: string;
  content_summary: string | null;
  published_at: string | null;
  url: string | null;
  media: string | null;
  source_slug: string;
  source_name: string;
  source_type: string;
  type: string;
};

export interface LatestReleasesFilter {
  /** Limit to a single source by id (mutually exclusive with orgId) */
  sourceId?: string;
  /** Limit to an org's sources by id (mutually exclusive with sourceId) */
  orgId?: string;
  /** Include coverage-side rows (hidden by default) */
  includeCoverage?: boolean;
  limit: number;
}

export async function getLatestReleasesAcross(
  d1: D1Database,
  f: LatestReleasesFilter,
): Promise<LatestReleaseRow[]> {
  const releasesTable = f.includeCoverage ? "releases" : "releases_visible";
  const wheres: string[] = [
    "(s.is_hidden = 0 OR s.is_hidden IS NULL)",
    "(r.suppressed IS NULL OR r.suppressed = 0)",
  ];
  const bindings: (string | number)[] = [];

  if (f.sourceId) {
    wheres.push("s.id = ?");
    bindings.push(f.sourceId);
  } else if (f.orgId) {
    wheres.push("s.org_id = ?");
    bindings.push(f.orgId);
  }

  const whereSql = wheres.join(" AND ");
  bindings.push(f.limit);

  const stmt = d1
    .prepare(
      `
    SELECT r.id, r.version, r.title, r.content_summary, r.type,
           r.published_at, r.url, r.media,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type
    FROM ${releasesTable} r
    INNER JOIN sources_active s ON s.id = r.source_id
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
