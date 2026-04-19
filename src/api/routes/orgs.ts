import { eq, desc, count, max, sql, and, inArray } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { organizations, orgAccounts, sources, releases, products } from "@releases/core-internal/schema";
import { getOrgMetrics } from "../metrics.js";
import type { SitemapPayload } from "../types.js";

export function handleOrgs() {
  const db = getDb();

  const rows = db
    .select({
      slug: organizations.slug,
      name: organizations.name,
      domain: organizations.domain,
      avatarUrl: organizations.avatarUrl,
      description: organizations.description,
      id: organizations.id,
    })
    .from(organizations)
    .orderBy(organizations.name)
    .all();

  // Batch-fetch all GitHub handles to avoid N+1
  const ghAccounts = db.select({ orgId: orgAccounts.orgId, handle: orgAccounts.handle })
    .from(orgAccounts)
    .where(eq(orgAccounts.platform, "github"))
    .all();
  const ghByOrgId = new Map(ghAccounts.map(a => [a.orgId, a.handle]));

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
      avatarUrl: org.avatarUrl ?? null,
      githubHandle: ghByOrgId.get(org.id) ?? null,
      description: org.description,
      sourceCount: srcCount.n,
      releaseCount: relCount.n,
      lastActivity: latest.maxDate ?? null,
    };
  });
}

export function handleSitemap(): SitemapPayload {
  const db = getDb();

  const orgRows = db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      lastActivity: max(sources.lastFetchedAt),
    })
    .from(organizations)
    .leftJoin(sources, eq(sources.orgId, organizations.id))
    .groupBy(organizations.id)
    .all();

  if (orgRows.length === 0) return { orgs: [], sources: [], products: [] };

  const orgIds = orgRows.map((o) => o.id);

  const sourceRows = db
    .select({
      orgId: sources.orgId,
      slug: sources.slug,
      id: sources.id,
      isHidden: sources.isHidden,
    })
    .from(sources)
    .where(inArray(sources.orgId, orgIds))
    .all();

  const productRows = db
    .select({ orgId: products.orgId, slug: products.slug })
    .from(products)
    .where(inArray(products.orgId, orgIds))
    .all();

  const latestReleaseRows = db
    .select({ sourceId: releases.sourceId, latestDate: max(releases.publishedAt) })
    .from(releases)
    .innerJoin(sources, eq(releases.sourceId, sources.id))
    .where(and(inArray(sources.orgId, orgIds), sql`${releases.publishedAt} IS NOT NULL`))
    .groupBy(releases.sourceId)
    .all();

  const latestBySource = new Map<string, string>();
  for (const row of latestReleaseRows) {
    if (row.latestDate) latestBySource.set(row.sourceId, row.latestDate);
  }

  const orgIdToSlug = new Map(orgRows.map((o) => [o.id, o.slug]));

  // Every row here was fetched via inArray(orgId, orgIds) so orgIdToSlug.get
  // is guaranteed to resolve — flatMap lets us skip hidden rows in one pass.
  return {
    orgs: orgRows.map((o) => ({ slug: o.slug, lastActivity: o.lastActivity ?? null })),
    sources: sourceRows.flatMap((s) =>
      s.isHidden || !s.orgId
        ? []
        : [{ orgSlug: orgIdToSlug.get(s.orgId)!, slug: s.slug, latestDate: latestBySource.get(s.id) ?? null }],
    ),
    products: productRows.flatMap((p) =>
      !p.orgId ? [] : [{ orgSlug: orgIdToSlug.get(p.orgId)!, slug: p.slug }],
    ),
  };
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
    slug: org.slug, name: org.name, domain: org.domain, avatarUrl: org.avatarUrl ?? null, description: org.description,
    sourceCount: orgSources.length, releaseCount: totalReleases.n,
    releasesLast30Days: metrics.releasesLast30Days,
    avgReleasesPerWeek: metrics.avgReleasesPerWeek,
    lastFetchedAt: latestFetch.maxFetch ?? null,
    trackingSince: metrics.oldestPublishedAt ?? org.createdAt, accounts, sources: sourcesWithStats,
  };
}
