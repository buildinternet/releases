import { eq, desc, count, and, sql, isNull } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, releases, organizations, sourceChangelogFiles } from "../../db/schema.js";
import { getSourceMetrics } from "../metrics.js";
import type { SourceChangelogResponse } from "../types.js";
import { buildChangelogResponse } from "../../lib/changelog-slice.js";

export function handleSourceActivity(slug: string, searchParams: URLSearchParams) {
  const db = getDb();

  const [src] = db.select().from(sources).where(eq(sources.slug, slug)).all();
  if (!src) return null;

  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");

  // Default range: oldest to newest release
  let from = fromParam;
  let to = toParam;
  if (!from || !to) {
    const [bounds] = db.all<{ oldest: string | null; newest: string | null }>(sql`
      SELECT MIN(published_at) AS oldest, MAX(published_at) AS newest
      FROM releases
      WHERE source_id = ${src.id}
        AND published_at IS NOT NULL
        AND (suppressed IS NULL OR suppressed = 0)
    `);
    const today = new Date().toISOString().slice(0, 10);
    if (!from) from = bounds.oldest?.slice(0, 10) ?? today;
    if (!to) to = bounds.newest?.slice(0, 10) ?? today;
  }

  const toDate = new Date(to + "T00:00:00Z");
  toDate.setUTCDate(toDate.getUTCDate() + 1);
  const toExclusive = toDate.toISOString().slice(0, 10);

  const bucketRows = db.all<{
    week_start: string;
    cnt: number;
    earliest_version: string | null;
    latest_version: string | null;
  }>(sql`
    WITH bucketed AS (
      SELECT
        strftime('%Y-%m-%d', published_at, 'weekday 0', '-6 days') AS week_start,
        COUNT(*) AS cnt,
        MIN(CASE WHEN version IS NOT NULL THEN published_at || '|' || version END) AS earliest_tagged,
        MAX(CASE WHEN version IS NOT NULL THEN published_at || '|' || version END) AS latest_tagged
      FROM releases
      WHERE
        source_id = ${src.id}
        AND published_at IS NOT NULL
        AND (suppressed IS NULL OR suppressed = 0)
        AND published_at >= ${from}
        AND published_at < ${toExclusive}
      GROUP BY week_start
    )
    SELECT week_start, cnt,
      CASE WHEN earliest_tagged IS NOT NULL
        THEN SUBSTR(earliest_tagged, INSTR(earliest_tagged, '|') + 1)
        ELSE NULL END AS earliest_version,
      CASE WHEN latest_tagged IS NOT NULL
        THEN SUBSTR(latest_tagged, INSTR(latest_tagged, '|') + 1)
        ELSE NULL END AS latest_version
    FROM bucketed
    ORDER BY week_start
  `);

  let orgSlug: string | null = null;
  let orgName: string | null = null;
  if (src.orgId) {
    const [org] = db.select({ slug: organizations.slug, name: organizations.name })
      .from(organizations).where(eq(organizations.id, src.orgId)).all();
    if (org) { orgSlug = org.slug; orgName = org.name; }
  }

  return {
    source: { slug: src.slug, name: src.name, orgSlug, orgName },
    range: { from, to },
    weeklyBuckets: bucketRows.map((r) => ({
      weekStart: r.week_start,
      count: r.cnt,
      earliestVersion: r.earliest_version ?? null,
      latestVersion: r.latest_version ?? null,
    })),
  };
}

export function handleSources(searchParams: URLSearchParams) {
  const db = getDb();
  const independent = searchParams.get("independent") === "true";

  const query = independent
    ? db.select().from(sources).where(isNull(sources.orgId))
    : db.select().from(sources);

  const rows = query.orderBy(sources.name).all();

  return rows.map((src) => {
    const [relCount] = db.select({ n: count() }).from(releases).where(eq(releases.sourceId, src.id)).all();

    const [latest] = db.select({ version: releases.version, publishedAt: releases.publishedAt })
      .from(releases)
      .where(and(eq(releases.sourceId, src.id), sql`${releases.publishedAt} IS NOT NULL`))
      .orderBy(desc(releases.publishedAt)).limit(1).all();

    let orgSlug: string | null = null;
    if (src.orgId) {
      const [org] = db.select({ slug: organizations.slug }).from(organizations)
        .where(eq(organizations.id, src.orgId)).all();
      orgSlug = org?.slug ?? null;
    }

    return {
      slug: src.slug, name: src.name, type: src.type, url: src.url, orgSlug,
      releaseCount: relCount.n,
      latestVersion: latest?.version ?? null,
      latestDate: latest?.publishedAt ?? null,
    };
  });
}

export function handleSourceDetail(slug: string, page: number, pageSize: number) {
  const db = getDb();

  const [src] = db.select().from(sources).where(eq(sources.slug, slug)).all();
  if (!src) return null;

  let org: { slug: string; name: string } | null = null;
  if (src.orgId) {
    const [orgRow] = db.select({ slug: organizations.slug, name: organizations.name })
      .from(organizations).where(eq(organizations.id, src.orgId)).all();
    org = orgRow ?? null;
  }

  const [relCount] = db.select({ n: count() }).from(releases).where(eq(releases.sourceId, src.id)).all();

  const offset = (page - 1) * pageSize;
  const releaseRows = db.all<{
    version: string | null; title: string; content_summary: string | null;
    content: string; published_at: string | null; url: string | null;
  }>(sql`
    SELECT version, title, content_summary, content, published_at, url
    FROM releases WHERE source_id = ${src.id}
    ORDER BY
      CASE WHEN published_at IS NOT NULL THEN 0 ELSE 1 END,
      published_at DESC, fetched_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `);

  const releasesFormatted = releaseRows.map((r) => ({
    version: r.version, title: r.title,
    summary: r.content_summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
    content: r.content.length > 800 ? r.content.slice(0, 800) + "..." : r.content,
    publishedAt: r.published_at, url: r.url,
  }));

  const [latest] = db.select({ version: releases.version, publishedAt: releases.publishedAt })
    .from(releases)
    .where(and(eq(releases.sourceId, src.id), sql`${releases.publishedAt} IS NOT NULL`))
    .orderBy(desc(releases.publishedAt)).limit(1).all();

  const latestVersion = latest?.version ?? (() => {
    const [fallback] = db.select({ version: releases.version }).from(releases)
      .where(eq(releases.sourceId, src.id)).orderBy(desc(releases.fetchedAt)).limit(1).all();
    return fallback?.version ?? null;
  })();

  const metrics = getSourceMetrics(src.id);
  const totalPages = Math.ceil(relCount.n / pageSize);

  const meta = JSON.parse(src.metadata || "{}");

  const changelogExistsRows = db.select({ one: sql<number>`1` })
    .from(sourceChangelogFiles)
    .where(eq(sourceChangelogFiles.sourceId, src.id))
    .limit(1)
    .all();
  const hasChangelogFile = changelogExistsRows.length > 0;

  return {
    slug: src.slug, name: src.name, type: src.type, url: src.url,
    changelogUrl: meta.changelogUrl ?? null,
    hasChangelogFile,
    org,
    releaseCount: relCount.n,
    releasesLast30Days: metrics.releasesLast30Days,
    avgReleasesPerWeek: metrics.avgReleasesPerWeek,
    latestVersion, latestDate: latest?.publishedAt ?? null,
    lastFetchedAt: src.lastFetchedAt,
    trackingSince: metrics.oldestPublishedAt ?? src.createdAt,
    releases: releasesFormatted,
    pagination: { page, pageSize, totalPages, totalItems: relCount.n },
  };
}

/**
 * Symbol returned when an explicit `path` param doesn't match any file.
 * Callers should surface this as a 404 distinct from "source has no files".
 */
export const CHANGELOG_PATH_NOT_FOUND = Symbol("changelog_path_not_found");

export function handleSourceChangelog(
  slug: string,
  searchParams?: URLSearchParams,
): SourceChangelogResponse | null | typeof CHANGELOG_PATH_NOT_FOUND {
  const db = getDb();
  const [src] = db.select().from(sources).where(eq(sources.slug, slug)).all();
  if (!src) return null;
  const allRows = db
    .select()
    .from(sourceChangelogFiles)
    .where(eq(sourceChangelogFiles.sourceId, src.id))
    .orderBy(sourceChangelogFiles.path)
    .all();
  if (allRows.length === 0) return null;

  const requestedPath = searchParams?.get("path") ?? null;
  let selected = allRows[0];
  if (requestedPath) {
    const match = allRows.find((r) => r.path === requestedPath);
    if (!match) return CHANGELOG_PATH_NOT_FOUND;
    selected = match;
  } else {
    // Default to the root CHANGELOG (no slash in path) when available.
    const root = allRows.find((r) => !r.path.includes("/"));
    if (root) selected = root;
  }

  const files = allRows.map((r) => ({
    path: r.path,
    filename: r.filename,
    url: r.url,
    bytes: r.bytes,
    fetchedAt: r.fetchedAt,
  }));

  return buildChangelogResponse(
    selected,
    {
      offset: searchParams?.get("offset") ?? null,
      limit: searchParams?.get("limit") ?? null,
    },
    files,
  );
}
