import { eq, desc, count, and, sql, isNull } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, releases, organizations } from "../../db/schema.js";
import { getSourceMetrics } from "../metrics.js";

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

  return {
    slug: src.slug, name: src.name, type: src.type, url: src.url, org,
    releaseCount: relCount.n,
    releasesLast30Days: metrics.releasesLast30Days,
    avgReleasesPerWeek: metrics.avgReleasesPerWeek,
    latestVersion, latestDate: latest?.publishedAt ?? null,
    trackingSince: src.createdAt,
    releases: releasesFormatted,
    pagination: { page, pageSize, totalPages, totalItems: relCount.n },
  };
}
