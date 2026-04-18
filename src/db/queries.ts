import { eq, desc, gte, lt, and, or, sql, like, inArray, count, isNotNull } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { getDb } from "./connection.js";
import {
  sources, releases, organizations, orgAccounts, ignoredUrls, blockedUrls, fetchLog, usageLog, releaseSummaries, mediaAssets, products, tags, orgTags, productTags, domainAliases, knowledgePages, sourceChangelogFiles,
  type Source, type Release, type Organization, type OrgAccount, type IgnoredUrl, type BlockedUrl,
  type ReleaseSummary, type NewReleaseSummary, type Product, type Tag, type DomainAlias,
  type KnowledgePage, type SourceChangelogFile,
} from "@buildinternet/releases-core/schema";
import { releaseCoverage, type ReleaseCoverage } from "./schema-coverage.js";
import { RELEASE_URL_UPSERT, type ReleaseUpsertRow } from "@releases/core/release-upsert";
import { isRemoteMode } from "../lib/mode.js";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { toSlug } from "@buildinternet/releases-core/slug";
import { countTokensSafe } from "@releases/core/tokens";
import * as apiClient from "../api/client.js";
import type {
  SourceWithOrg, SourcePatchInput, ReleaseWithSource,
  StatsSummary, FetchLogEntry, LatestRelease, UsageBreakdownRow, UsageStatsResponse,
} from "../api/types.js";
export type {
  SourceWithOrg, SourcePatchInput, ReleaseWithSource,
  StatsSummary, FetchLogEntry, LatestRelease, UsageBreakdownRow, UsageStatsResponse,
};

/** Reusable SQL condition: exclude disabled (hidden) sources. */
const notDisabled = sql`(${sources.isHidden} = 0 OR ${sources.isHidden} IS NULL)`;

const notCoverage = sql`NOT EXISTS (SELECT 1 FROM release_coverage WHERE release_coverage.coverage_id = ${releases.id})`;

export async function findSource(identifier: string): Promise<Source | null> {
  if (identifier.startsWith("src_")) {
    if (isRemoteMode()) return apiClient.findSource(identifier);
    const db = getDb();
    const [source] = await db.select().from(sources).where(eq(sources.id, identifier));
    return source ?? null;
  }
  const normalized = identifier.toLowerCase();
  if (isRemoteMode()) return apiClient.findSource(normalized);
  const db = getDb();
  const [source] = await db.select().from(sources).where(eq(sources.slug, normalized));
  return source ?? null;
}

export async function listAllSources(): Promise<Source[]> {
  if (isRemoteMode()) {
    return apiClient.listFetchableSources({ mode: "all" });
  }
  const db = getDb();
  return db.select().from(sources);
}

export async function getRecentReleases(
  sourceId: string,
  cutoffIso: string,
  sourceSlug?: string,
): Promise<Release[]> {
  if (isRemoteMode() && sourceSlug) {
    return apiClient.getRecentReleases(sourceSlug, cutoffIso);
  }
  const db = getDb();
  return db
    .select()
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), gte(releases.publishedAt, cutoffIso), eq(releases.suppressed, false)))
    .orderBy(desc(releases.publishedAt));
}

export async function findOrg(identifier: string): Promise<Organization | null> {
  // 0. ID (exact — IDs are case-sensitive)
  if (identifier.startsWith("org_")) {
    if (isRemoteMode()) return apiClient.findOrg(identifier);
    const db = getDb();
    const [byId] = await db.select().from(organizations).where(eq(organizations.id, identifier));
    return byId ?? null;
  }

  if (isRemoteMode()) return apiClient.findOrg(identifier.toLowerCase());
  const db = getDb();

  // 1. Slug (case-insensitive — slugs are always lowercase)
  const [bySlug] = await db.select().from(organizations).where(eq(organizations.slug, identifier.toLowerCase()));
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

  // 5. Domain alias
  const [byAlias] = await db
    .select({ org: organizations })
    .from(domainAliases)
    .innerJoin(organizations, eq(domainAliases.orgId, organizations.id))
    .where(eq(domainAliases.domain, identifier));
  if (byAlias) return byAlias.org;

  return null;
}

export async function suggestOrgs(term: string, limit = 5): Promise<Array<{ slug: string; name: string }>> {
  const lower = term.toLowerCase();
  if (isRemoteMode()) return apiClient.suggestOrgs(lower, limit);
  const db = getDb();
  return db
    .select({ slug: organizations.slug, name: organizations.name })
    .from(organizations)
    .where(or(
      like(organizations.slug, `%${lower}%`),
      sql`LOWER(${organizations.name}) LIKE ${"%" + lower + "%"}`,
    ))
    .limit(limit);
}

export async function suggestSources(term: string, limit = 5): Promise<Array<{ slug: string; name: string }>> {
  const lower = term.toLowerCase();
  if (isRemoteMode()) return apiClient.suggestSources(lower, limit);
  const db = getDb();
  return db
    .select({ slug: sources.slug, name: sources.name })
    .from(sources)
    .where(or(
      like(sources.slug, `%${lower}%`),
      sql`LOWER(${sources.name}) LIKE ${"%" + lower + "%"}`,
    ))
    .limit(limit);
}

export async function getOrgById(orgId: string): Promise<Organization | null> {
  if (isRemoteMode()) return null; // Remote mode: no ID-based lookup; callers treat null as "not found → enabled"
  const db = getDb();
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  return org ?? null;
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
  if (isRemoteMode()) return apiClient.getRecentReleasesByOrg(orgId, cutoffIso);
  const db = getDb();
  const rows = await db
    .select({
      id: releases.id,
      sourceId: releases.sourceId,
      version: releases.version,
      type: releases.type,
      title: releases.title,
      content: releases.content,
      contentSummary: releases.contentSummary,
      url: releases.url,
      contentHash: releases.contentHash,
      metadata: releases.metadata,
      media: releases.media,
      publishedAt: releases.publishedAt,
      suppressed: releases.suppressed,
      suppressedReason: releases.suppressedReason,
      fetchedAt: releases.fetchedAt,
      embeddedAt: releases.embeddedAt,
      sourceName: sources.name,
      sourceSlug: sources.slug,
    })
    .from(releases)
    .innerJoin(sources, eq(releases.sourceId, sources.id))
    .where(and(eq(sources.orgId, orgId), gte(releases.publishedAt, cutoffIso), eq(releases.suppressed, false), notDisabled))
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
  productId?: string | null;
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
    productId: data.productId ?? null,
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

/** Returns true if content is unchanged (hash matches). Persists the new hash on change unless dryRun is set. */
export async function checkContentHash(
  source: Source,
  contentHash: string,
  options?: { dryRun?: boolean },
): Promise<boolean> {
  if (isRemoteMode()) return apiClient.checkContentHash(source, contentHash);
  if (source.lastContentHash === contentHash) return true;
  if (!options?.dryRun) {
    const db = getDb();
    await db.update(sources).set({ lastContentHash: contentHash }).where(eq(sources.id, source.id));
  }
  return false;
}

// ── List sources with org name (for `list` command) ──

export async function listSourcesWithOrg(opts?: {
  orgSlug?: string;
  productSlug?: string;
  hasFeed?: boolean;
  query?: string;
  includeHidden?: boolean;
  category?: string;
  limit?: number;
  offset?: number;
}): Promise<SourceWithOrg[]> {
  if (isRemoteMode()) return apiClient.listSourcesWithOrg(opts);
  const db = getDb();

  const conditions = [];

  if (opts?.orgSlug) {
    const org = await findOrg(opts.orgSlug);
    if (!org) return [];
    conditions.push(eq(sources.orgId, org.id));
  }

  if (opts?.productSlug) {
    const product = await findProduct(opts.productSlug);
    if (!product) return [];
    conditions.push(eq(sources.productId, product.id));
  }

  if (opts?.category) {
    conditions.push(
      or(
        eq(organizations.category, opts.category),
        eq(products.category, opts.category),
      )!,
    );
  }

  if (opts?.hasFeed) {
    conditions.push(
      sql`json_extract(${sources.metadata}, '$.feedUrl') IS NOT NULL AND json_extract(${sources.metadata}, '$.feedUrl') != ''`,
    );
  }

  if (!opts?.includeHidden) {
    conditions.push(
      notDisabled,
    );
  }

  if (opts?.query) {
    const pattern = `%${opts.query.toLowerCase()}%`;
    conditions.push(
      or(
        like(sql`lower(${sources.name})`, pattern),
        like(sql`lower(${sources.slug})`, pattern),
        like(sql`lower(${sources.url})`, pattern),
      )!,
    );
  }

  const query = db
    .select({
      id: sources.id,
      name: sources.name,
      slug: sources.slug,
      type: sources.type,
      url: sources.url,
      lastFetchedAt: sources.lastFetchedAt,
      fetchPriority: sources.fetchPriority,
      changeDetectedAt: sources.changeDetectedAt,
      consecutiveNoChange: sources.consecutiveNoChange,
      consecutiveErrors: sources.consecutiveErrors,
      nextFetchAfter: sources.nextFetchAfter,
      // Columns added in workers/api/migrations/20260418134132; the
      // published @buildinternet/releases-core schema doesn't know about
      // them yet, so reference by raw column name. Safe: local DBs get
      // both columns from the matching Drizzle migration.
      medianGapDays: sql<number | null>`median_gap_days`.as("medianGapDays"),
      lastRetieredAt: sql<string | null>`last_retiered_at`.as("lastRetieredAt"),
      orgName: organizations.name,
      orgSlug: organizations.slug,
      productName: products.name,
      productSlug: products.slug,
      metadata: sources.metadata,
      isPrimary: sql<boolean>`coalesce(${sources.isPrimary}, 0)`.as("isPrimary"),
      isHidden: sources.isHidden,
      releaseCount: sql<number>`(SELECT COUNT(*) FROM ${releases} WHERE ${releases.sourceId} = ${sources.id} AND (${releases.suppressed} IS NULL OR ${releases.suppressed} = 0))`.as("releaseCount"),
      latestVersion: sql<string | null>`(SELECT ${releases.version} FROM ${releases} WHERE ${releases.sourceId} = ${sources.id} AND (${releases.suppressed} IS NULL OR ${releases.suppressed} = 0) AND ${releases.publishedAt} IS NOT NULL ORDER BY ${releases.publishedAt} DESC LIMIT 1)`.as("latestVersion"),
      latestDate: sql<string | null>`(SELECT MAX(${releases.publishedAt}) FROM ${releases} WHERE ${releases.sourceId} = ${sources.id} AND (${releases.suppressed} IS NULL OR ${releases.suppressed} = 0))`.as("latestDate"),
    })
    .from(sources)
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .leftJoin(products, eq(sources.productId, products.id));

  let baseQuery = conditions.length > 0
    ? query.where(and(...conditions))
    : query;

  if (opts?.limit != null) {
    baseQuery = (baseQuery as typeof baseQuery).limit(opts.limit) as typeof baseQuery;
  }
  if (opts?.offset != null && opts.offset > 0) {
    baseQuery = (baseQuery as typeof baseQuery).offset(opts.offset) as typeof baseQuery;
  }

  const rows = await baseQuery;

  return rows.map((r) => ({
    ...r,
    releaseCount: r.releaseCount ?? 0,
    latestVersion: r.latestVersion ?? null,
    latestDate: r.latestDate ?? null,
  }));
}

// ── Stats summary (for `stats` command) ──


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
    .where(notDisabled)
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
    sourceActivity: perSource,
    recentActivity: recentFetches,
  };
}

// ── Fetch log (for `fetch-log` command) ──


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


export async function getLatestReleases(opts: {
  slug?: string;
  orgSlug?: string;
  count: number;
  includeCoverage?: boolean;
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
    const orgSources = await db.select({ id: sources.id }).from(sources).where(and(eq(sources.orgId, org.id), notDisabled));
    orgSourceIds = orgSources.map((s) => s.id);
    if (orgSourceIds.length === 0) return [];
  }

  const coverageFilter = opts.includeCoverage ? undefined : notCoverage;
  const baseWhere = and(eq(releases.suppressed, false), notDisabled, coverageFilter);
  let whereClause;
  if (opts.slug) {
    whereClause = and(eq(sources.slug, opts.slug), baseWhere);
  } else if (orgSourceIds) {
    whereClause = and(inArray(releases.sourceId, orgSourceIds), baseWhere);
  } else {
    whereClause = baseWhere;
  }

  const rows = await db
    .select({
      id: releases.id,
      title: releases.title,
      version: releases.version,
      publishedAt: releases.publishedAt,
      sourceName: sources.name,
      sourceSlug: sources.slug,
      contentSummary: releases.contentSummary,
      media: releases.media,
    })
    .from(releases)
    .innerJoin(sources, eq(releases.sourceId, sources.id))
    .where(whereClause)
    .orderBy(desc(releases.publishedAt))
    .limit(opts.count);

  return rows.map((r) => ({
    ...r,
    media: (() => { try { return JSON.parse(r.media || "[]"); } catch { return []; } })(),
  }));
}

// ── Known releases for incremental parsing ──

// Canonical type lives in src/ai/shared.ts; re-export for backward compat
import type { KnownRelease } from "../ai/shared.js";
export type { KnownRelease };

export async function getKnownReleasesForSource(
  sourceId: string,
  sourceSlug: string,
  limit = 10,
): Promise<KnownRelease[]> {
  if (isRemoteMode()) return apiClient.getKnownReleasesForSource(sourceSlug, limit);
  const db = getDb();
  return db
    .select({
      version: releases.version,
      title: releases.title,
      publishedAt: releases.publishedAt,
    })
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), eq(releases.suppressed, false)))
    .orderBy(desc(releases.publishedAt))
    .limit(limit);
}

// ── Org CRUD (for `org` command) ──

export async function createOrg(
  name: string,
  opts?: { slug?: string; domain?: string; description?: string; category?: string; avatarUrl?: string },
): Promise<Organization> {
  if (isRemoteMode()) return apiClient.createOrg(name, opts);
  const db = getDb();
  const slug = opts?.slug ?? toSlug(name);
  const now = new Date().toISOString();
  const [created] = await db.insert(organizations).values({
    name,
    slug,
    domain: opts?.domain ?? null,
    description: opts?.description ?? null,
    category: opts?.category ?? null,
    avatarUrl: opts?.avatarUrl ?? null,
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

export async function updateOrg(org: Organization, data: Record<string, unknown>): Promise<Organization> {
  if (isRemoteMode()) return apiClient.updateOrg(org.slug, data);
  const db = getDb();
  data.updatedAt = new Date().toISOString();
  const [updated] = await db.update(organizations).set(data).where(eq(organizations.id, org.id)).returning();
  return updated;
}

export async function getOrgAccountsBySlug(
  orgSlug: string,
  orgId: string,
): Promise<OrgAccount[]> {
  if (isRemoteMode()) return apiClient.getOrgAccountsBySlug(orgSlug);
  const db = getDb();
  return db
    .select()
    .from(orgAccounts)
    .where(eq(orgAccounts.orgId, orgId));
}

// ── Product queries ──

export async function createProduct(
  orgId: string,
  name: string,
  opts?: { slug?: string; url?: string; description?: string; category?: string },
): Promise<Product> {
  if (isRemoteMode()) return apiClient.createProduct(orgId, name, opts);
  const db = getDb();
  const slug = opts?.slug ?? toSlug(name);
  const [created] = await db.insert(products).values({
    name,
    slug,
    orgId,
    url: opts?.url ?? null,
    description: opts?.description ?? null,
    category: opts?.category ?? null,
  }).returning();
  return created;
}

export async function findProduct(identifier: string): Promise<Product | null> {
  if (isRemoteMode()) return apiClient.findProduct(identifier);
  const db = getDb();
  // ID-first (consistent with findSource/findOrg)
  if (identifier.startsWith("prod_")) {
    const [byId] = await db.select().from(products).where(eq(products.id, identifier));
    if (byId) return byId;
  }
  const [bySlug] = await db.select().from(products).where(eq(products.slug, identifier));
  if (bySlug) return bySlug;
  // Domain alias lookup
  const [byAlias] = await db
    .select({ product: products })
    .from(domainAliases)
    .innerJoin(products, eq(domainAliases.productId, products.id))
    .where(eq(domainAliases.domain, identifier));
  if (byAlias) return byAlias.product;
  return null;
}

export async function getProductsByOrg(orgId: string): Promise<Array<Product & { sourceCount: number }>> {
  if (isRemoteMode()) return apiClient.getProductsByOrg(orgId);
  const db = getDb();
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      orgId: products.orgId,
      url: products.url,
      description: products.description,
      category: products.category,
      createdAt: products.createdAt,
      embeddedAt: products.embeddedAt,
      sourceCount: sql<number>`(SELECT COUNT(*) FROM sources s WHERE s.product_id = products.id)`,
    })
    .from(products)
    .where(eq(products.orgId, orgId))
    .orderBy(products.name);
  return rows;
}

export async function updateProduct(product: Product, data: Record<string, unknown>): Promise<Product> {
  if (isRemoteMode()) return apiClient.updateProduct(product.slug, data);
  const db = getDb();
  const [updated] = await db.update(products).set(data).where(eq(products.id, product.id)).returning();
  return updated;
}

export async function deleteProduct(productId: string): Promise<void> {
  if (isRemoteMode()) return apiClient.deleteProduct(productId);
  const db = getDb();
  await db.delete(products).where(eq(products.id, productId));
}

// ── Domain alias queries ──

export async function addDomainAlias(
  domain: string,
  target: { orgId?: string; productId?: string },
): Promise<DomainAlias> {
  if (isRemoteMode()) return apiClient.addDomainAlias(domain, target);
  const db = getDb();
  const [created] = await db
    .insert(domainAliases)
    .values({ domain, orgId: target.orgId ?? null, productId: target.productId ?? null })
    .returning();
  return created;
}

export async function removeDomainAlias(
  domain: string,
  scope?: { orgId?: string; productId?: string },
): Promise<boolean> {
  if (isRemoteMode()) return apiClient.removeDomainAlias(domain);
  const db = getDb();
  const conditions = [eq(domainAliases.domain, domain)];
  if (scope?.orgId) conditions.push(eq(domainAliases.orgId, scope.orgId));
  if (scope?.productId) conditions.push(eq(domainAliases.productId, scope.productId));
  const deleted = await db
    .delete(domainAliases)
    .where(and(...conditions))
    .returning();
  return deleted.length > 0;
}

export async function listDomainAliases(
  target: { orgId?: string; productId?: string },
): Promise<DomainAlias[]> {
  if (isRemoteMode()) {
    return apiClient.listDomainAliases(target);
  }
  const db = getDb();
  if (target.orgId) {
    return db.select().from(domainAliases).where(eq(domainAliases.orgId, target.orgId));
  }
  if (target.productId) {
    return db.select().from(domainAliases).where(eq(domainAliases.productId, target.productId));
  }
  return [];
}

// ── Tag queries ──

export async function getOrCreateTag(name: string): Promise<Tag> {
  if (isRemoteMode()) return apiClient.getOrCreateTag(name);
  const db = getDb();
  const slug = toSlug(name);
  const [existing] = await db.select().from(tags).where(eq(tags.slug, slug));
  if (existing) return existing;
  const [created] = await db.insert(tags).values({ name, slug }).returning();
  return created;
}

export async function getTagsForOrg(orgId: string): Promise<string[]> {
  if (isRemoteMode()) return apiClient.getTagsForOrg(orgId);
  const db = getDb();
  const rows = await db
    .select({ name: tags.name })
    .from(orgTags)
    .innerJoin(tags, eq(orgTags.tagId, tags.id))
    .where(eq(orgTags.orgId, orgId))
    .orderBy(tags.name);
  return rows.map((r) => r.name);
}

export async function addTagsToOrg(orgId: string, tagNames: string[]): Promise<void> {
  if (isRemoteMode()) return apiClient.addTagsToOrg(orgId, tagNames);
  const db = getDb();
  for (const name of tagNames) {
    const tag = await getOrCreateTag(name);
    await db.insert(orgTags).values({ orgId, tagId: tag.id }).onConflictDoNothing();
  }
}

export async function removeTagsFromOrg(orgId: string, tagNames: string[]): Promise<void> {
  if (isRemoteMode()) return apiClient.removeTagsFromOrg(orgId, tagNames);
  const db = getDb();
  for (const name of tagNames) {
    const slug = toSlug(name);
    const [tag] = await db.select().from(tags).where(eq(tags.slug, slug));
    if (tag) {
      await db.delete(orgTags).where(and(eq(orgTags.orgId, orgId), eq(orgTags.tagId, tag.id)));
    }
  }
}

export async function getTagsForProduct(productId: string): Promise<string[]> {
  if (isRemoteMode()) return apiClient.getTagsForProduct(productId);
  const db = getDb();
  const rows = await db
    .select({ name: tags.name })
    .from(productTags)
    .innerJoin(tags, eq(productTags.tagId, tags.id))
    .where(eq(productTags.productId, productId))
    .orderBy(tags.name);
  return rows.map((r) => r.name);
}

export async function addTagsToProduct(productId: string, tagNames: string[]): Promise<void> {
  if (isRemoteMode()) return apiClient.addTagsToProduct(productId, tagNames);
  const db = getDb();
  for (const name of tagNames) {
    const tag = await getOrCreateTag(name);
    await db.insert(productTags).values({ productId, tagId: tag.id }).onConflictDoNothing();
  }
}

export async function removeTagsFromProduct(productId: string, tagNames: string[]): Promise<void> {
  if (isRemoteMode()) return apiClient.removeTagsFromProduct(productId, tagNames);
  const db = getDb();
  for (const name of tagNames) {
    const slug = toSlug(name);
    const [tag] = await db.select().from(tags).where(eq(tags.slug, slug));
    if (tag) {
      await db.delete(productTags).where(and(eq(productTags.productId, productId), eq(productTags.tagId, tag.id)));
    }
  }
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

// ── Release coverage ──

export async function linkReleaseCoverage(row: {
  canonicalId: string;
  coverageId: string;
  reason?: string | null;
  decidedBy: string;
}): Promise<void> {
  if (row.canonicalId === row.coverageId) {
    throw new Error("a release cannot be coverage of itself");
  }
  if (isRemoteMode()) return apiClient.linkReleaseCoverage(row);
  const db = getDb();
  await db.insert(releaseCoverage).values({
    canonicalId: row.canonicalId,
    coverageId: row.coverageId,
    reason: row.reason ?? null,
    decidedBy: row.decidedBy,
  }).onConflictDoUpdate({
    target: releaseCoverage.coverageId,
    set: {
      canonicalId: row.canonicalId,
      reason: row.reason ?? null,
      decidedBy: row.decidedBy,
      decidedAt: new Date().toISOString(),
    },
  });
}

export async function unlinkReleaseCoverage(releaseId: string): Promise<boolean> {
  if (isRemoteMode()) return apiClient.unlinkReleaseCoverage(releaseId);
  const db = getDb();
  const deleted = await db.delete(releaseCoverage)
    .where(eq(releaseCoverage.coverageId, releaseId))
    .returning({ id: releaseCoverage.coverageId });
  return deleted.length > 0;
}

export async function getReleaseCoverage(releaseId: string): Promise<{
  role: "canonical" | "coverage" | "standalone";
  canonical: ReleaseCoverage | null;
  covers: ReleaseCoverage[];
}> {
  if (isRemoteMode()) return apiClient.getReleaseCoverage(releaseId);
  const db = getDb();
  const [asCoverage] = await db.select().from(releaseCoverage)
    .where(eq(releaseCoverage.coverageId, releaseId))
    .limit(1);
  if (asCoverage) return { role: "coverage", canonical: asCoverage, covers: [] };
  const covers = await db.select().from(releaseCoverage)
    .where(eq(releaseCoverage.canonicalId, releaseId));
  if (covers.length > 0) return { role: "canonical", canonical: null, covers };
  return { role: "standalone", canonical: null, covers: [] };
}

export async function getCoverageForReleaseIds(
  releaseIds: string[],
): Promise<ReleaseCoverage[]> {
  if (isRemoteMode() || releaseIds.length === 0) return [];
  const db = getDb();
  return db.select().from(releaseCoverage)
    .where(inArray(releaseCoverage.coverageId, releaseIds));
}

// ── Search ──

export async function unifiedSearch(
  query: string,
  limit: number,
  opts?: { org?: string; mode?: "lexical" | "semantic" | "hybrid"; includeCoverage?: boolean },
): Promise<import("../api/types.js").UnifiedSearchResponse> {
  if (isRemoteMode()) {
    return apiClient.unifiedSearch(query, limit, opts);
  }
  const { unifiedSearchLocal } = await import("./fts.js");
  return { query, ...unifiedSearchLocal(query, limit, 0, { includeCoverage: opts?.includeCoverage }) };
}

// ── Source CRUD helpers ──

export async function findSourcesBySlugs(slugs: string[]): Promise<Source[]> {
  if (isRemoteMode()) {
    const results = await Promise.all(slugs.map((s) => apiClient.findSource(s)));
    return results.filter((s): s is Source => s !== null);
  }
  const db = getDb();
  return db.select().from(sources).where(inArray(sources.slug, slugs));
}

export async function deleteSources(slugs: string[]): Promise<void> {
  if (isRemoteMode()) {
    await Promise.all(slugs.map((s) => apiClient.deleteSource(s)));
    return;
  }
  const db = getDb();
  await db.delete(sources).where(inArray(sources.slug, slugs));
}

export async function updateSource(source: Source, data: Record<string, unknown>): Promise<Source> {
  if (isRemoteMode()) {
    return apiClient.updateSource(source.slug, data);
  }
  const db = getDb();
  const [updated] = await db.update(sources).set(data).where(eq(sources.id, source.id)).returning();
  return updated;
}

// ── Fetchable sources (for `fetch` command) ──

export async function listFetchableSources(opts: {
  mode: "unfetched" | "stale" | "retry_errors";
  staleHours?: number;
}): Promise<Source[]> {
  if (isRemoteMode()) {
    return apiClient.listFetchableSources(opts);
  }
  const db = getDb();
  if (opts.mode === "unfetched") {
    return db.select().from(sources).where(and(sql`${sources.lastFetchedAt} IS NULL`, notDisabled));
  }
  if (opts.mode === "stale" && opts.staleHours) {
    const cutoff = new Date(Date.now() - opts.staleHours * 3600_000).toISOString();
    const now = new Date().toISOString();
    return db.select().from(sources).where(
      and(
        sql`(${sources.lastFetchedAt} IS NULL OR ${sources.lastFetchedAt} < ${cutoff})`,
        sql`(${sources.nextFetchAfter} IS NULL OR ${sources.nextFetchAfter} <= ${now})`,
        sql`${sources.fetchPriority} != 'paused'`,
        notDisabled
      )
    );
  }
  if (opts.mode === "retry_errors") {
    return db.select().from(sources).where(
      and(
        sql`${sources.id} IN (
          SELECT f.source_id FROM fetch_log f
          WHERE f.id = (SELECT f2.id FROM fetch_log f2 WHERE f2.source_id = f.source_id ORDER BY f2.created_at DESC LIMIT 1)
          AND f.status = 'error'
        )`,
        notDisabled
      )
    );
  }
  return db.select().from(sources).where(notDisabled);
}

/** List sources that have a discovered feed URL in metadata. */
export async function listFeedSources(): Promise<Source[]> {
  if (isRemoteMode()) {
    return apiClient.listFeedSources();
  }
  const db = getDb();
  return db.select().from(sources).where(
    and(
      sql`json_extract(${sources.metadata}, '$.feedUrl') IS NOT NULL`,
      sql`${sources.fetchPriority} != 'paused'`,
      notDisabled,
    )
  );
}

/** List scrape sources that don't have a feed URL (candidates for HEAD pre-check). */
export async function listScrapeSources(): Promise<Source[]> {
  if (isRemoteMode()) {
    return []; // Not yet supported in remote mode
  }
  const db = getDb();
  return db.select().from(sources).where(
    and(
      eq(sources.type, "scrape"),
      sql`(json_extract(${sources.metadata}, '$.feedUrl') IS NULL OR json_extract(${sources.metadata}, '$.feedUrl') = '')`,
      sql`(json_extract(${sources.metadata}, '$.headCheckUseless') IS NULL OR json_extract(${sources.metadata}, '$.headCheckUseless') = false)`,
      sql`${sources.fetchPriority} != 'paused'`,
      notDisabled,
    )
  );
}

export async function setChangeDetected(source: Source): Promise<void> {
  const now = new Date().toISOString();
  if (isRemoteMode()) {
    await apiClient.updateSource(source.slug, { changeDetectedAt: now });
    return;
  }
  const db = getDb();
  await db.update(sources).set({ changeDetectedAt: now }).where(eq(sources.id, source.id));
}

export async function clearChangeDetected(source: Source): Promise<void> {
  if (isRemoteMode()) {
    await apiClient.updateSource(source.slug, { changeDetectedAt: null });
    return;
  }
  const db = getDb();
  await db.update(sources).set({ changeDetectedAt: null }).where(eq(sources.id, source.id));
}

export async function listSourcesWithChanges(): Promise<Source[]> {
  if (isRemoteMode()) {
    return apiClient.listSourcesWithChanges();
  }
  const db = getDb();
  return db.select().from(sources).where(
    and(
      sql`${sources.changeDetectedAt} IS NOT NULL`,
      notDisabled,
    )
  );
}

export async function deleteReleasesForSource(source: Source): Promise<number> {
  if (isRemoteMode()) {
    const result = await apiClient.deleteReleasesForSource(source.slug);
    return result.deleted;
  }
  const db = getDb();
  const deleted = await db.delete(releases).where(eq(releases.sourceId, source.id)).returning();
  return deleted.length;
}

export async function insertReleases(source: Source, rows: ReleaseUpsertRow[]): Promise<number> {
  if (isRemoteMode()) {
    const result = await apiClient.insertReleasesBatch(source.slug, rows);
    return result.inserted;
  }
  const db = getDb();
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const result = await db.insert(releases).values(chunk)
      .onConflictDoUpdate(RELEASE_URL_UPSERT)
      .returning({ id: releases.id });
    inserted += result.length;
  }
  // NOTE: No embed-on-write in local mode. The local CLI has no Vectorize
  // binding (Vectorize is a Cloudflare-only resource), so semantic search is
  // remote-only for now. The API Worker handles embedding on its side via
  // workers/api/src/routes/sources.ts (POST /sources/:slug/releases/batch).
  // For local databases, use the backfill CLI (coming in task 8) to
  // populate vectors against a remote Vectorize index if desired.
  return inserted;
}

// ── Release CRUD (for `release` command) ──

export async function getRelease(id: string): Promise<ReleaseWithSource | null> {
  if (isRemoteMode()) return apiClient.getRelease(id);
  const db = getDb();
  const rows = await db
    .select({
      release: releases,
      sourceName: sources.name,
      sourceSlug: sources.slug,
    })
    .from(releases)
    .leftJoin(sources, eq(releases.sourceId, sources.id))
    .where(eq(releases.id, id));
  if (rows.length === 0) return null;
  const { release: rel, sourceName, sourceSlug } = rows[0];
  return {
    ...rel,
    suppressed: !!rel.suppressed,
    sourceName,
    sourceSlug,
  };
}

export async function deleteRelease(id: string): Promise<boolean> {
  if (isRemoteMode()) {
    return apiClient.deleteRelease(id);
  }
  const db = getDb();
  const deleted = await db.delete(releases).where(eq(releases.id, id)).returning({ id: releases.id });
  return deleted.length > 0;
}

export async function updateRelease(id: string, data: Record<string, unknown>): Promise<Release | null> {
  if (isRemoteMode()) {
    const result = await apiClient.updateRelease(id, data);
    if (!result) return null;
    return result as unknown as Release;
  }
  const db = getDb();
  const [updated] = await db.update(releases).set(data).where(eq(releases.id, id)).returning();
  return updated ?? null;
}

export async function deleteReleasesByFilter(opts: {
  sourceId?: string;
  before?: string;
  dryRun?: boolean;
}): Promise<{ deleted: number; releases: Array<{ id: string; title: string }> }> {
  if (isRemoteMode()) {
    throw new Error("deleteReleasesByFilter not yet supported in remote mode — delete individually");
  }
  const db = getDb();
  const conditions = [];
  if (opts.sourceId) conditions.push(eq(releases.sourceId, opts.sourceId));
  if (opts.before) conditions.push(lt(releases.publishedAt, opts.before));

  // Preview what would be deleted
  const preview = await db
    .select({ id: releases.id, title: releases.title })
    .from(releases)
    .where(and(...conditions));

  if (opts.dryRun) {
    return { deleted: 0, releases: preview };
  }

  const deleted = await db
    .delete(releases)
    .where(and(...conditions))
    .returning({ id: releases.id });

  return { deleted: deleted.length, releases: preview };
}

// ── Usage stats (for `usage` command) ──


/** @deprecated Use UsageStatsResponse */
export type UsageStats = UsageStatsResponse;

function usageByColumn(db: ReturnType<typeof getDb>, column: SQLiteColumn, since: string) {
  return db
    .select({
      label: column,
      totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
      totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(usageLog)
    .where(gte(usageLog.createdAt, since))
    .groupBy(column) as Promise<UsageBreakdownRow[]>;
}

export async function getUsageStats(days: number): Promise<UsageStats> {
  if (isRemoteMode()) {
    return apiClient.getUsageStats(days);
  }
  const db = getDb();
  const since = daysAgoIso(days);

  const [totals, byOperation, byModel, bySource] = await Promise.all([
    db
      .select({
        totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(usageLog)
      .where(gte(usageLog.createdAt, since)),
    usageByColumn(db, usageLog.operation, since),
    usageByColumn(db, usageLog.model, since),
    db
      .select({
        label: usageLog.sourceSlug,
        totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(usageLog)
      .where(and(gte(usageLog.createdAt, since), isNotNull(usageLog.sourceSlug)))
      .groupBy(usageLog.sourceSlug) as Promise<UsageBreakdownRow[]>,
  ]);

  return { totals: totals[0], byOperation, byModel, bySource };
}

// ── Fetch log ──

export async function insertFetchLog(entry: {
  sourceId: string;
  releasesFound: number;
  releasesInserted: number;
  durationMs?: number | null;
  status: "success" | "error" | "no_change" | "dry_run";
  error?: string | null;
  rawContent?: string | null;
  sessionId?: string | null;
}): Promise<void> {
  if (isRemoteMode()) {
    await apiClient.postFetchLog(entry);
    return;
  }
  const db = getDb();
  await db.insert(fetchLog).values({
    sourceId: entry.sourceId,
    sessionId: entry.sessionId ?? null,
    releasesFound: entry.releasesFound,
    releasesInserted: entry.releasesInserted,
    durationMs: entry.durationMs ?? null,
    status: entry.status,
    error: entry.error ?? null,
    rawContent: entry.rawContent ?? null,
  });
}

// ── Release summaries ──

export async function getSummariesForSource(
  sourceId: string,
): Promise<ReleaseSummary[]> {
  if (isRemoteMode()) {
    return apiClient.getSummariesForSource(sourceId);
  }
  const db = getDb();
  return db
    .select()
    .from(releaseSummaries)
    .where(eq(releaseSummaries.sourceId, sourceId))
    .orderBy(desc(releaseSummaries.generatedAt));
}

export async function upsertSummary(
  data: NewReleaseSummary,
): Promise<void> {
  if (isRemoteMode()) {
    return apiClient.upsertSummary(data);
  }
  const db = getDb();
  await db
    .insert(releaseSummaries)
    .values(data)
    .onConflictDoUpdate({
      target: [releaseSummaries.sourceId, releaseSummaries.orgId, releaseSummaries.type, releaseSummaries.year, releaseSummaries.month],
      set: {
        summary: data.summary,
        releaseCount: data.releaseCount,
        windowDays: data.windowDays,
        generatedAt: new Date().toISOString(),
      },
    });
}

export async function getMonthlySummary(
  sourceId: string,
  year: number,
  month: number,
): Promise<ReleaseSummary | undefined> {
  if (isRemoteMode()) {
    return apiClient.getMonthlySummary(sourceId, year, month);
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(releaseSummaries)
    .where(
      and(
        eq(releaseSummaries.sourceId, sourceId),
        eq(releaseSummaries.type, "monthly"),
        eq(releaseSummaries.year, year),
        eq(releaseSummaries.month, month),
      ),
    );
  return row;
}

// ── Overview Pages ──

export async function getOrgOverview(orgId: string, orgSlug?: string): Promise<KnowledgePage | null> {
  if (isRemoteMode() && orgSlug) {
    return apiClient.getOverview("org", orgSlug);
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, orgId)));
  return row ?? null;
}

export async function getProductOverview(productId: string, productSlug?: string): Promise<KnowledgePage | null> {
  if (isRemoteMode() && productSlug) {
    return apiClient.getOverview("product", productSlug);
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "product"), eq(knowledgePages.productId, productId)));
  return row ?? null;
}

export async function getPlaybookForOrg(orgId: string, orgSlug?: string): Promise<KnowledgePage | null> {
  if (isRemoteMode() && orgSlug) {
    return apiClient.getPlaybook(orgSlug);
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "playbook"), eq(knowledgePages.orgId, orgId)));
  return row ?? null;
}

export async function upsertOverviewPage(
  data: { scope: "org" | "product" | "playbook"; orgId?: string | null; productId?: string | null; content: string; notes?: string | null; releaseCount: number; lastContributingReleaseAt?: string | null },
): Promise<void> {
  if (isRemoteMode()) {
    return apiClient.upsertOverview(data);
  }
  const db = getDb();
  const now = new Date().toISOString();
  const conflictTarget = data.scope === "product"
    ? [knowledgePages.scope, knowledgePages.productId]
    : [knowledgePages.scope, knowledgePages.orgId];
  await db
    .insert(knowledgePages)
    .values({
      scope: data.scope,
      orgId: data.orgId ?? null,
      productId: data.productId ?? null,
      content: data.content,
      notes: data.notes ?? null,
      releaseCount: data.releaseCount,
      lastContributingReleaseAt: data.lastContributingReleaseAt ?? null,
      generatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: conflictTarget,
      set: {
        content: data.content,
        releaseCount: data.releaseCount,
        lastContributingReleaseAt: data.lastContributingReleaseAt ?? null,
        updatedAt: now,
      },
    });
}

export async function updatePlaybookNotes(orgId: string, orgSlug: string, notes: string): Promise<void> {
  if (isRemoteMode()) {
    return apiClient.updatePlaybookNotes(orgSlug, notes);
  }
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .update(knowledgePages)
    .set({ notes: notes.trim() || null, updatedAt: now })
    .where(and(eq(knowledgePages.scope, "playbook"), eq(knowledgePages.orgId, orgId)));
}

// ── Media Assets ──

import type { UploadResult } from "../lib/media.js";

export interface MediaAssetInput extends UploadResult {
  sourceId?: string | null;
  releaseId?: string | null;
}

/** Insert media assets, deduplicating by r2Key. Returns count of newly inserted rows. */
export async function insertMediaAssets(assets: MediaAssetInput[]): Promise<number> {
  if (assets.length === 0) return 0;

  // Deduplicate by r2Key — the same image can appear multiple times in a single
  // batch when a changelog post embeds the same screenshot more than once.
  // SQLite's ON CONFLICT DO NOTHING only resolves conflicts against existing rows,
  // not between rows in the same INSERT statement.
  const seen = new Set<string>();
  const deduped = assets.filter((a) => {
    if (seen.has(a.r2Key)) return false;
    seen.add(a.r2Key);
    return true;
  });

  if (isRemoteMode()) {
    const result = await apiClient.insertMediaAssets(deduped);
    return result.inserted;
  }

  const db = getDb();
  let inserted = 0;
  for (let i = 0; i < deduped.length; i += 500) {
    const chunk = deduped.slice(i, i + 500);
    const result = await db
      .insert(mediaAssets)
      .values(chunk.map((a) => ({
        r2Key: a.r2Key,
        sourceUrl: a.sourceUrl,
        sourceFilename: a.sourceFilename,
        contentType: a.contentType,
        contentHash: a.contentHash,
        byteSize: a.byteSize,
        sourceId: a.sourceId ?? null,
        releaseId: a.releaseId ?? null,
      })))
      .onConflictDoNothing()
      .returning({ id: mediaAssets.id });
    inserted += result.length;
  }
  return inserted;
}

/** Get total media asset count and byte size. */
export async function getMediaAssetStats(): Promise<{ count: number; totalBytes: number }> {
  if (isRemoteMode()) {
    return apiClient.getMediaAssetStats();
  }
  const db = getDb();
  const [row] = await db
    .select({
      count: count(),
      totalBytes: sql<number>`COALESCE(SUM(${mediaAssets.byteSize}), 0)`,
    })
    .from(mediaAssets);
  return { count: row?.count ?? 0, totalBytes: row?.totalBytes ?? 0 };
}

// ── Source changelog files ──

export interface ChangelogFileInput {
  path: string;
  filename: string;
  url: string;
  rawUrl: string;
  content: string;
  contentHash: string;
  bytes: number;
  /**
   * True when the raw file exceeded the 1MB cap and content was sliced.
   * Derived at fetch time and threaded through to API/MCP/web responses.
   * Not persisted as a column — `bytes === CHANGELOG_MAX_BYTES` is a
   * sufficient stable signal across reads.
   */
  truncated?: boolean;
}

/** Local-mode only. The worker mirrors this in workers/api/src/cron/poll-fetch.ts#refreshChangelogFile. */
export async function upsertChangelogFile(sourceId: string, file: ChangelogFileInput): Promise<{ inserted: boolean; updated: boolean }> {
  const db = getDb();
  const now = new Date().toISOString();
  const [existing] = await db
    .select()
    .from(sourceChangelogFiles)
    .where(and(eq(sourceChangelogFiles.sourceId, sourceId), eq(sourceChangelogFiles.path, file.path)));

  if (!existing) {
    await db.insert(sourceChangelogFiles).values({
      sourceId,
      path: file.path,
      filename: file.filename,
      url: file.url,
      rawUrl: file.rawUrl,
      content: file.content,
      contentHash: file.contentHash,
      bytes: file.bytes,
      tokens: countTokensSafe(file.content),
      fetchedAt: now,
    });
    return { inserted: true, updated: false };
  }

  if (existing.contentHash === file.contentHash) {
    const touch: { fetchedAt: string; tokens?: number } = { fetchedAt: now };
    if (existing.tokens === null) touch.tokens = countTokensSafe(existing.content);
    await db.update(sourceChangelogFiles)
      .set(touch)
      .where(eq(sourceChangelogFiles.id, existing.id));
    return { inserted: false, updated: false };
  }

  await db.update(sourceChangelogFiles).set({
    filename: file.filename,
    url: file.url,
    rawUrl: file.rawUrl,
    content: file.content,
    contentHash: file.contentHash,
    bytes: file.bytes,
    tokens: countTokensSafe(file.content),
    fetchedAt: now,
  }).where(eq(sourceChangelogFiles.id, existing.id));
  return { inserted: false, updated: true };
}

export async function getChangelogFile(sourceId: string): Promise<SourceChangelogFile | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(sourceChangelogFiles)
    .where(eq(sourceChangelogFiles.sourceId, sourceId))
    .orderBy(sourceChangelogFiles.path);
  if (rows.length === 0) return null;
  // Prefer the root CHANGELOG over the first-by-path fallback so single-file
  // sources and monorepos both return the canonical root file by default.
  const root = rows.find((r) => !r.path.includes("/"));
  return root ?? rows[0];
}

export async function listChangelogFiles(sourceId: string): Promise<SourceChangelogFile[]> {
  const db = getDb();
  return db
    .select()
    .from(sourceChangelogFiles)
    .where(eq(sourceChangelogFiles.sourceId, sourceId))
    .orderBy(sourceChangelogFiles.path);
}

export async function getChangelogFileByPath(
  sourceId: string,
  path: string,
): Promise<SourceChangelogFile | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(sourceChangelogFiles)
    .where(and(eq(sourceChangelogFiles.sourceId, sourceId), eq(sourceChangelogFiles.path, path)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Delete changelog rows whose `path` is no longer in the discovered set.
 * Used to prune per-package CHANGELOGs that have been removed from a
 * monorepo upstream. Pass an empty array to delete all rows for a source.
 */
export async function deleteChangelogFilesNotIn(
  sourceId: string,
  keepPaths: string[],
): Promise<number> {
  const db = getDb();
  const existing = await db
    .select({ id: sourceChangelogFiles.id, path: sourceChangelogFiles.path })
    .from(sourceChangelogFiles)
    .where(eq(sourceChangelogFiles.sourceId, sourceId));
  const keep = new Set(keepPaths);
  const toDelete = existing.filter((row) => !keep.has(row.path));
  if (toDelete.length === 0) return 0;
  for (const row of toDelete) {
    await db.delete(sourceChangelogFiles).where(eq(sourceChangelogFiles.id, row.id));
  }
  return toDelete.length;
}
