import { eq, desc, gte, and, or, sql, inArray, count } from "drizzle-orm";
import { getDb } from "./connection.js";
import {
  sources, releases, organizations, orgAccounts, ignoredUrls, blockedUrls, fetchLog,
  type Source, type Release, type Organization, type OrgAccount, type IgnoredUrl, type BlockedUrl,
} from "./schema.js";
import { isRemoteMode } from "../lib/mode.js";
import { daysAgoIso } from "../lib/dates.js";
import { toSlug } from "../lib/slug.js";
import * as apiClient from "../api/client.js";

export async function findSourceBySlug(slug: string): Promise<Source | null> {
  if (isRemoteMode()) return apiClient.findSourceBySlug(slug);
  const db = getDb();
  const [source] = await db.select().from(sources).where(eq(sources.slug, slug));
  return source ?? null;
}

export async function getRecentReleases(
  sourceId: string,
  cutoffIso: string,
): Promise<Release[]> {
  // TODO: add remote mode support (used only by AI summary/compare; not yet implemented in API)
  const db = getDb();
  return db
    .select()
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), gte(releases.publishedAt, cutoffIso), eq(releases.suppressed, false)))
    .orderBy(desc(releases.publishedAt));
}

export async function findOrg(identifier: string): Promise<Organization | null> {
  if (isRemoteMode()) return apiClient.findOrg(identifier);
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
  if (isRemoteMode()) return apiClient.getSourcesByOrg(orgId);
  const db = getDb();
  return db.select().from(sources).where(eq(sources.orgId, orgId));
}

export async function getRecentReleasesByOrg(
  orgId: string,
  cutoffIso: string,
): Promise<Array<Release & { sourceName: string; sourceSlug: string }>> {
  // TODO: add remote mode support (used only by AI summary/compare; not yet implemented in API)
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
      suppressed: releases.suppressed,
      suppressedReason: releases.suppressedReason,
      fetchedAt: releases.fetchedAt,
      sourceName: sources.name,
      sourceSlug: sources.slug,
    })
    .from(releases)
    .innerJoin(sources, eq(releases.sourceId, sources.id))
    .where(and(eq(sources.orgId, orgId), gte(releases.publishedAt, cutoffIso), eq(releases.suppressed, false)))
    .orderBy(desc(releases.publishedAt));
  return rows;
}

export async function listOrgs(opts?: {
  query?: string;
  platform?: string;
}): Promise<Organization[]> {
  if (isRemoteMode()) return apiClient.listOrgs(opts);
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
  if (isRemoteMode()) return apiClient.getOrgAccountByPlatform(orgId, platform);
  const db = getDb();
  const [account] = await db
    .select()
    .from(orgAccounts)
    .where(and(eq(orgAccounts.orgId, orgId), eq(orgAccounts.platform, platform)));
  return account ?? null;
}

export async function createSource(data: {
  name: string;
  slug: string;
  type: string;
  url: string;
  orgId?: string | null;
  metadata?: string;
}): Promise<Source> {
  if (isRemoteMode()) return apiClient.createSource(data);
  const db = getDb();
  const [created] = await db.insert(sources).values({
    name: data.name,
    slug: data.slug,
    type: data.type as "github" | "scrape" | "feed" | "agent",
    url: data.url,
    orgId: data.orgId ?? null,
    metadata: data.metadata,
  }).returning();
  return created;
}

export async function findSourcesByUrls(urls: string[]): Promise<Source[]> {
  if (urls.length === 0) return [];
  if (isRemoteMode()) return apiClient.findSourcesByUrls(urls);
  const db = getDb();
  return db.select().from(sources).where(inArray(sources.url, urls));
}

// ── Ignored URLs (org-scoped) ──

export async function findIgnoredUrl(url: string, orgId: string): Promise<IgnoredUrl | null> {
  if (isRemoteMode()) return apiClient.findIgnoredUrl(url, orgId);
  const db = getDb();
  const [row] = await db.select().from(ignoredUrls)
    .where(and(eq(ignoredUrls.url, url), eq(ignoredUrls.orgId, orgId)));
  return row ?? null;
}

export async function addIgnoredUrl(url: string, orgId: string, reason?: string): Promise<void> {
  if (isRemoteMode()) return apiClient.addIgnoredUrl(url, orgId, reason);
  const db = getDb();
  await db.insert(ignoredUrls).values({
    url,
    orgId,
    reason: reason ?? null,
  }).onConflictDoNothing();
}

export async function listIgnoredUrls(orgId: string): Promise<IgnoredUrl[]> {
  if (isRemoteMode()) return apiClient.listIgnoredUrls(orgId);
  const db = getDb();
  return db.select().from(ignoredUrls).where(eq(ignoredUrls.orgId, orgId));
}

export async function removeIgnoredUrl(url: string, orgId: string): Promise<void> {
  if (isRemoteMode()) return apiClient.removeIgnoredUrl(url, orgId);
  const db = getDb();
  await db.delete(ignoredUrls)
    .where(and(eq(ignoredUrls.url, url), eq(ignoredUrls.orgId, orgId)));
}

// ── Blocked URLs (global) ──

export async function findBlockedUrl(url: string): Promise<BlockedUrl | null> {
  if (isRemoteMode()) return apiClient.findBlockedUrl(url);
  const db = getDb();
  let domain = "";
  try { domain = new URL(url).hostname; } catch { /* not a valid URL, skip domain match */ }
  const rows = await db.select().from(blockedUrls)
    .where(
      or(
        and(eq(blockedUrls.pattern, url), eq(blockedUrls.type, "exact")),
        ...(domain ? [and(eq(blockedUrls.pattern, domain), eq(blockedUrls.type, "domain"))] : []),
      ),
    )
    .limit(2);
  // Prefer exact match over domain match
  return rows.find((r) => r.type === "exact") ?? rows[0] ?? null;
}

export async function addBlockedUrl(pattern: string, type: "exact" | "domain", reason?: string): Promise<void> {
  if (isRemoteMode()) return apiClient.addBlockedUrl(pattern, type, reason);
  const db = getDb();
  await db.insert(blockedUrls).values({
    pattern,
    type,
    reason: reason ?? null,
  }).onConflictDoNothing();
}

export async function listBlockedUrls(): Promise<BlockedUrl[]> {
  if (isRemoteMode()) return apiClient.listBlockedUrls();
  const db = getDb();
  return db.select().from(blockedUrls);
}

export async function removeBlockedUrl(pattern: string): Promise<void> {
  if (isRemoteMode()) return apiClient.removeBlockedUrl(pattern);
  const db = getDb();
  await db.delete(blockedUrls).where(eq(blockedUrls.pattern, pattern));
}

/** Check if a URL is blocked globally OR ignored for a specific org */
export async function isUrlExcluded(url: string, orgId?: string): Promise<{ excluded: boolean; reason?: string; scope?: "blocked" | "ignored" }> {
  if (orgId) {
    const [blocked, ignored] = await Promise.all([
      findBlockedUrl(url),
      findIgnoredUrl(url, orgId),
    ]);
    if (blocked) return { excluded: true, reason: blocked.reason ?? undefined, scope: "blocked" };
    if (ignored) return { excluded: true, reason: ignored.reason ?? undefined, scope: "ignored" };
    return { excluded: false };
  }
  const blocked = await findBlockedUrl(url);
  if (blocked) return { excluded: true, reason: blocked.reason ?? undefined, scope: "blocked" };
  return { excluded: false };
}

/** Returns true if content is unchanged (hash matches). Persists the new hash on change. */
export async function checkContentHash(
  source: Source,
  contentHash: string,
): Promise<boolean> {
  if (isRemoteMode()) return apiClient.checkContentHash(source, contentHash);
  if (source.lastContentHash === contentHash) return true;
  const db = getDb();
  await db.update(sources).set({ lastContentHash: contentHash }).where(eq(sources.id, source.id));
  return false;
}

// ── List sources with org name (for `list` command) ──

export interface SourceWithOrg {
  id: string;
  name: string;
  slug: string;
  type: string;
  url: string;
  lastFetchedAt: string | null;
  orgName: string | null;
}

export async function listSourcesWithOrg(): Promise<SourceWithOrg[]> {
  if (isRemoteMode()) return apiClient.listSourcesWithOrg();
  const db = getDb();
  return db
    .select({
      id: sources.id,
      name: sources.name,
      slug: sources.slug,
      type: sources.type,
      url: sources.url,
      lastFetchedAt: sources.lastFetchedAt,
      orgName: organizations.name,
    })
    .from(sources)
    .leftJoin(organizations, eq(sources.orgId, organizations.id));
}

// ── Stats summary (for `stats` command) ──

export type StatsSummary = apiClient.StatsSummary;

export async function getStatsSummary(days: number): Promise<StatsSummary> {
  if (isRemoteMode()) return apiClient.getStatsSummary(days);

  const db = getDb();
  const cutoff = daysAgoIso(days);

  // Aggregate counts
  const [orgCount] = await db.select({ n: count() }).from(organizations);
  const [sourceCount] = await db.select({ n: count() }).from(sources);
  const [releaseCount] = await db.select({ n: count() }).from(releases);
  const [recentReleaseCount] = await db
    .select({ n: count() })
    .from(releases)
    .where(gte(releases.publishedAt, cutoff));

  // Sources never fetched
  const [neverFetched] = await db
    .select({ n: count() })
    .from(sources)
    .where(sql`${sources.lastFetchedAt} IS NULL`);

  // Sources fetched within the period
  const [recentlyFetched] = await db
    .select({ n: count() })
    .from(sources)
    .where(gte(sources.lastFetchedAt, cutoff));

  const staleCount = sourceCount.n - neverFetched.n - recentlyFetched.n;

  // Per-source release counts (top sources)
  const perSource = await db
    .select({
      sourceName: sources.name,
      sourceSlug: sources.slug,
      sourceType: sources.type,
      orgName: organizations.name,
      lastFetchedAt: sources.lastFetchedAt,
      totalReleases: count(releases.id),
      recentReleases: sql<number>`SUM(CASE WHEN ${releases.publishedAt} >= ${cutoff} THEN 1 ELSE 0 END)`,
    })
    .from(sources)
    .leftJoin(releases, eq(releases.sourceId, sources.id))
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .groupBy(sources.id)
    .orderBy(desc(sql`SUM(CASE WHEN ${releases.publishedAt} >= ${cutoff} THEN 1 ELSE 0 END)`));

  // Recent fetch activity
  const recentFetches = await db
    .select({
      sourceName: sources.name,
      sourceSlug: sources.slug,
      orgName: organizations.name,
      releasesFound: fetchLog.releasesFound,
      releasesInserted: fetchLog.releasesInserted,
      totalReleases: sql<number>`(SELECT COUNT(*) FROM releases WHERE releases.source_id = ${sources.id})`,
      status: fetchLog.status,
      durationMs: fetchLog.durationMs,
      error: fetchLog.error,
      createdAt: fetchLog.createdAt,
    })
    .from(fetchLog)
    .innerJoin(sources, eq(fetchLog.sourceId, sources.id))
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .orderBy(desc(fetchLog.createdAt))
    .limit(20);

  return {
    period: { days, cutoff },
    totals: {
      organizations: orgCount.n,
      sources: sourceCount.n,
      releases: releaseCount.n,
      releasesInPeriod: recentReleaseCount.n,
    },
    sourceHealth: {
      upToDate: recentlyFetched.n,
      stale: staleCount,
      neverFetched: neverFetched.n,
    },
    sources: perSource,
    recentActivity: recentFetches,
  };
}

// ── Fetch log (for `fetch-log` command) ──

export type FetchLogEntry = apiClient.FetchLogEntry;

export async function getFetchLogs(opts: {
  sourceSlug?: string;
  limit: number;
}): Promise<FetchLogEntry[]> {
  if (isRemoteMode()) return apiClient.getFetchLogs(opts);

  const db = getDb();
  const limit = opts.limit;

  let query = db
    .select({
      id: fetchLog.id,
      sourceName: sources.name,
      sourceSlug: sources.slug,
      status: fetchLog.status,
      releasesFound: fetchLog.releasesFound,
      releasesInserted: fetchLog.releasesInserted,
      durationMs: fetchLog.durationMs,
      error: fetchLog.error,
      createdAt: fetchLog.createdAt,
    })
    .from(fetchLog)
    .innerJoin(sources, eq(fetchLog.sourceId, sources.id))
    .orderBy(desc(fetchLog.createdAt))
    .limit(limit);

  if (opts.sourceSlug) {
    query = query.where(eq(sources.slug, opts.sourceSlug)) as typeof query;
  }

  return query;
}

// ── Latest releases (for `latest` command) ──

export type LatestRelease = apiClient.LatestRelease;

export async function getLatestReleases(opts: {
  slug?: string;
  orgSlug?: string;
  count: number;
}): Promise<LatestRelease[]> {
  if (isRemoteMode()) return apiClient.getLatestReleases(opts);

  const db = getDb();

  if (opts.slug) {
    const [source] = await db.select().from(sources).where(eq(sources.slug, opts.slug));
    if (!source) return [];
  }

  let orgSourceIds: string[] | undefined;
  if (opts.orgSlug) {
    const org = await findOrg(opts.orgSlug);
    if (!org) return [];
    const orgSources = await db.select({ id: sources.id }).from(sources).where(eq(sources.orgId, org.id));
    orgSourceIds = orgSources.map((s) => s.id);
    if (orgSourceIds.length === 0) return [];
  }

  let query = db
    .select({
      title: releases.title,
      version: releases.version,
      publishedAt: releases.publishedAt,
      sourceName: sources.name,
    })
    .from(releases)
    .innerJoin(sources, eq(releases.sourceId, sources.id))
    .orderBy(desc(releases.publishedAt))
    .limit(opts.count);

  if (opts.slug) {
    query = query.where(and(eq(sources.slug, opts.slug), eq(releases.suppressed, false))) as typeof query;
  } else if (orgSourceIds) {
    query = query.where(and(inArray(releases.sourceId, orgSourceIds), eq(releases.suppressed, false))) as typeof query;
  } else {
    query = query.where(eq(releases.suppressed, false)) as typeof query;
  }

  return query;
}

// ── Org CRUD (for `org` command) ──

export async function createOrg(
  name: string,
  opts?: { slug?: string; domain?: string },
): Promise<Organization> {
  if (isRemoteMode()) return apiClient.createOrg(name, opts);
  const db = getDb();
  const slug = opts?.slug ?? toSlug(name);
  const now = new Date().toISOString();
  const [created] = await db.insert(organizations).values({
    name,
    slug,
    domain: opts?.domain ?? null,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return created;
}

export async function removeOrg(orgId: string, orgSlug: string): Promise<void> {
  if (isRemoteMode()) return apiClient.removeOrg(orgSlug);
  const db = getDb();
  await db.delete(organizations).where(eq(organizations.id, orgId));
}

export async function getOrgAccountsBySlug(
  orgSlug: string,
  orgId: string,
): Promise<OrgAccount[]> {
  if (isRemoteMode()) {
    const accounts = await apiClient.getOrgAccountsBySlug(orgSlug);
    // Map the simpler API shape to OrgAccount
    return accounts.map((a) => ({
      id: "",
      orgId: "",
      platform: a.platform,
      handle: a.handle,
      createdAt: "",
    }));
  }
  const db = getDb();
  return db
    .select()
    .from(orgAccounts)
    .where(eq(orgAccounts.orgId, orgId));
}

export async function linkOrgAccount(
  orgId: string,
  orgSlug: string,
  platform: string,
  handle: string,
): Promise<OrgAccount> {
  if (isRemoteMode()) return apiClient.linkOrgAccount(orgSlug, platform, handle);
  const db = getDb();
  const [created] = await db.insert(orgAccounts).values({
    orgId,
    platform,
    handle,
  }).returning();
  await db
    .update(organizations)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(organizations.id, orgId));
  return created;
}

export async function unlinkOrgAccount(
  orgId: string,
  orgSlug: string,
  platform: string,
  handle: string,
): Promise<void> {
  if (isRemoteMode()) return apiClient.unlinkOrgAccount(orgSlug, platform, handle);
  const db = getDb();
  await db
    .delete(orgAccounts)
    .where(
      and(
        eq(orgAccounts.orgId, orgId),
        eq(orgAccounts.platform, platform),
        eq(orgAccounts.handle, handle),
      ),
    );
  await db
    .update(organizations)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(organizations.id, orgId));
}

// ── Release suppression ──

export async function suppressRelease(releaseId: string, reason?: string): Promise<boolean> {
  if (isRemoteMode()) return apiClient.suppressRelease(releaseId, reason);
  const db = getDb();
  const [updated] = await db.update(releases).set({
    suppressed: true,
    suppressedReason: reason ?? null,
  }).where(eq(releases.id, releaseId)).returning({ id: releases.id });
  return !!updated;
}

export async function unsuppressRelease(releaseId: string): Promise<boolean> {
  if (isRemoteMode()) return apiClient.unsuppressRelease(releaseId);
  const db = getDb();
  const [updated] = await db.update(releases).set({
    suppressed: false,
    suppressedReason: null,
  }).where(eq(releases.id, releaseId)).returning({ id: releases.id });
  return !!updated;
}

// ── Search (remote-aware, for `search` command) ──

export type SearchResultRemote = apiClient.SearchResultRemote;

export async function searchReleasesRemote(
  query: string,
  limit: number,
  opts?: { org?: string },
): Promise<SearchResultRemote[]> {
  return apiClient.searchReleasesRemote(query, limit, opts);
}
