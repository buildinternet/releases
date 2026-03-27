import { eq, desc, count, max, sql, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { organizations, orgAccounts, sources, releases } from "../../db/schema.js";
import { getOrgMetrics } from "../metrics.js";

export function handleOrgs() {
  const db = getDb();

  const rows = db
    .select({
      slug: organizations.slug,
      name: organizations.name,
      domain: organizations.domain,
      id: organizations.id,
    })
    .from(organizations)
    .orderBy(organizations.name)
    .all();

  return rows.map((org) => {
    const [srcCount] = db.select({ n: count() }).from(sources).where(eq(sources.orgId, org.id)).all();
    const [relCount] = db.select({ n: count() }).from(releases)
      .innerJoin(sources, eq(releases.sourceId, sources.id))
      .where(eq(sources.orgId, org.id)).all();
    const [latest] = db.select({ maxDate: max(releases.publishedAt) }).from(releases)
      .innerJoin(sources, eq(releases.sourceId, sources.id))
      .where(and(eq(sources.orgId, org.id), sql`${releases.publishedAt} IS NOT NULL`)).all();

    return {
      slug: org.slug,
      name: org.name,
      domain: org.domain,
      sourceCount: srcCount.n,
      releaseCount: relCount.n,
      lastActivity: latest.maxDate ?? null,
    };
  });
}

export function handleOrgDetail(slug: string) {
  const db = getDb();

  const [org] = db.select().from(organizations).where(eq(organizations.slug, slug)).all();
  if (!org) return null;

  const accounts = db.select({ platform: orgAccounts.platform, handle: orgAccounts.handle })
    .from(orgAccounts).where(eq(orgAccounts.orgId, org.id)).all();

  const orgSources = db.select().from(sources).where(eq(sources.orgId, org.id)).orderBy(sources.name).all();

  const sourcesWithStats = orgSources.map((src) => {
    const [relCount] = db.select({ n: count() }).from(releases).where(eq(releases.sourceId, src.id)).all();

    const [latest] = db.select({ version: releases.version, publishedAt: releases.publishedAt })
      .from(releases)
      .where(and(eq(releases.sourceId, src.id), sql`${releases.publishedAt} IS NOT NULL`))
      .orderBy(desc(releases.publishedAt)).limit(1).all();

    const latestVersion = latest?.version ?? (() => {
      const [fallback] = db.select({ version: releases.version }).from(releases)
        .where(eq(releases.sourceId, src.id)).orderBy(desc(releases.fetchedAt)).limit(1).all();
      return fallback?.version ?? null;
    })();

    return {
      slug: src.slug, name: src.name, type: src.type, url: src.url,
      releaseCount: relCount.n, latestVersion, latestDate: latest?.publishedAt ?? null,
    };
  });

  const metrics = getOrgMetrics(org.id);
  const [totalReleases] = db.select({ n: count() }).from(releases)
    .innerJoin(sources, eq(releases.sourceId, sources.id))
    .where(eq(sources.orgId, org.id)).all();

  const [latestFetch] = db.select({ maxFetch: max(sources.lastFetchedAt) })
    .from(sources).where(eq(sources.orgId, org.id)).all();

  return {
    slug: org.slug, name: org.name, domain: org.domain,
    sourceCount: orgSources.length, releaseCount: totalReleases.n,
    releasesLast30Days: metrics.releasesLast30Days,
    avgReleasesPerWeek: metrics.avgReleasesPerWeek,
    lastFetchedAt: latestFetch.maxFetch ?? null,
    trackingSince: org.createdAt, accounts, sources: sourcesWithStats,
  };
}
