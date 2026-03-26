import { eq, desc, gte, and, sql, inArray } from "drizzle-orm";
import { getDb } from "./connection.js";
import {
  sources, releases, organizations, orgAccounts, ignoredUrls,
  type Source, type Release, type Organization, type OrgAccount, type IgnoredUrl,
} from "./schema.js";

export async function findSourceBySlug(slug: string): Promise<Source | null> {
  const db = getDb();
  const [source] = await db.select().from(sources).where(eq(sources.slug, slug));
  return source ?? null;
}

export async function getRecentReleases(
  sourceId: string,
  cutoffIso: string,
): Promise<Release[]> {
  const db = getDb();
  return db
    .select()
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), gte(releases.publishedAt, cutoffIso)))
    .orderBy(desc(releases.publishedAt));
}

export async function findOrg(identifier: string): Promise<Organization | null> {
  const db = getDb();

  // 1. Slug (exact)
  const [bySlug] = await db.select().from(organizations).where(eq(organizations.slug, identifier));
  if (bySlug) return bySlug;

  // 2. Domain (exact)
  const [byDomain] = await db.select().from(organizations).where(eq(organizations.domain, identifier));
  if (byDomain) return byDomain;

  // 3. Name (case-insensitive, oldest first for determinism)
  const [byName] = await db
    .select()
    .from(organizations)
    .where(sql`LOWER(${organizations.name}) = LOWER(${identifier})`)
    .orderBy(organizations.createdAt)
    .limit(1);
  if (byName) return byName;

  // 4. Account handle (exact)
  const [byHandle] = await db
    .select({ org: organizations })
    .from(orgAccounts)
    .innerJoin(organizations, eq(orgAccounts.orgId, organizations.id))
    .where(eq(orgAccounts.handle, identifier));
  if (byHandle) return byHandle.org;

  return null;
}

export async function getSourcesByOrg(orgId: string): Promise<Source[]> {
  const db = getDb();
  return db.select().from(sources).where(eq(sources.orgId, orgId));
}

export async function getRecentReleasesByOrg(
  orgId: string,
  cutoffIso: string,
): Promise<Array<Release & { sourceName: string; sourceSlug: string }>> {
  const db = getDb();
  const rows = await db
    .select({
      id: releases.id,
      sourceId: releases.sourceId,
      version: releases.version,
      title: releases.title,
      content: releases.content,
      contentSummary: releases.contentSummary,
      url: releases.url,
      contentHash: releases.contentHash,
      metadata: releases.metadata,
      publishedAt: releases.publishedAt,
      fetchedAt: releases.fetchedAt,
      sourceName: sources.name,
      sourceSlug: sources.slug,
    })
    .from(releases)
    .innerJoin(sources, eq(releases.sourceId, sources.id))
    .where(and(eq(sources.orgId, orgId), gte(releases.publishedAt, cutoffIso)))
    .orderBy(desc(releases.publishedAt));
  return rows;
}

export async function listOrgs(opts?: {
  query?: string;
  platform?: string;
}): Promise<Organization[]> {
  const db = getDb();
  let allOrgs = await db.select().from(organizations);

  if (opts?.platform) {
    const accountOrgIds = await db
      .select({ orgId: orgAccounts.orgId })
      .from(orgAccounts)
      .where(eq(orgAccounts.platform, opts.platform));
    const orgIdSet = new Set(accountOrgIds.map((a) => a.orgId));
    allOrgs = allOrgs.filter((o) => orgIdSet.has(o.id));
  }

  if (opts?.query && allOrgs.length > 0) {
    const q = opts.query.toLowerCase();
    const orgIds = allOrgs.map((o) => o.id);
    const accounts = await db
      .select()
      .from(orgAccounts)
      .where(inArray(orgAccounts.orgId, orgIds));
    const orgIdsWithMatchingHandle = new Set(
      accounts
        .filter((a) => a.handle.toLowerCase().includes(q))
        .map((a) => a.orgId),
    );
    allOrgs = allOrgs.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        o.slug.toLowerCase().includes(q) ||
        (o.domain && o.domain.toLowerCase().includes(q)) ||
        orgIdsWithMatchingHandle.has(o.id),
    );
  }

  return allOrgs;
}

export async function getOrgAccountByPlatform(
  orgId: string,
  platform: string,
): Promise<OrgAccount | null> {
  const db = getDb();
  const [account] = await db
    .select()
    .from(orgAccounts)
    .where(and(eq(orgAccounts.orgId, orgId), eq(orgAccounts.platform, platform)));
  return account ?? null;
}

export async function findSourcesByUrls(urls: string[]): Promise<Source[]> {
  if (urls.length === 0) return [];
  const db = getDb();
  return db.select().from(sources).where(inArray(sources.url, urls));
}

export async function findIgnoredUrl(url: string): Promise<IgnoredUrl | null> {
  const db = getDb();
  const [row] = await db.select().from(ignoredUrls).where(eq(ignoredUrls.url, url));
  return row ?? null;
}

export async function addIgnoredUrl(url: string, opts?: { orgId?: string; reason?: string }): Promise<void> {
  const db = getDb();
  await db.insert(ignoredUrls).values({
    url,
    orgId: opts?.orgId ?? null,
    reason: opts?.reason ?? null,
  }).onConflictDoNothing();
}

export async function listIgnoredUrls(orgId?: string): Promise<IgnoredUrl[]> {
  const db = getDb();
  if (orgId) {
    return db.select().from(ignoredUrls).where(eq(ignoredUrls.orgId, orgId));
  }
  return db.select().from(ignoredUrls);
}

export async function removeIgnoredUrl(url: string): Promise<void> {
  const db = getDb();
  await db.delete(ignoredUrls).where(eq(ignoredUrls.url, url));
}

/** Returns true if content is unchanged (hash matches). Persists the new hash on change. */
export async function checkContentHash(
  source: Source,
  contentHash: string,
): Promise<boolean> {
  if (source.lastContentHash === contentHash) return true;
  const db = getDb();
  await db.update(sources).set({ lastContentHash: contentHash }).where(eq(sources.id, source.id));
  return false;
}
