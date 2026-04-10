import { eq, desc, gte, lt, and, or, sql, like, inArray, count, isNotNull } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { getDb } from "./connection.js";
import {
  sources, releases, organizations, orgAccounts, ignoredUrls, blockedUrls, fetchLog, usageLog, releaseSummaries, mediaAssets, products, tags, orgTags, productTags, domainAliases, knowledgePages,
  type Source, type Release, type Organization, type OrgAccount, type IgnoredUrl, type BlockedUrl,
  type ReleaseSummary, type NewReleaseSummary, type MediaAsset, type Product, type Tag, type DomainAlias,
  type KnowledgePage, type NewKnowledgePage,
} from "./schema.js";
import { isRemoteMode } from "../lib/mode.js";
import { daysAgoIso } from "../lib/dates.js";
import { toSlug } from "../lib/slug.js";
import * as apiClient from "../api/client.js";

/** Reusable SQL condition: exclude disabled (hidden) sources. */
const notDisabled = sql`(${sources.isHidden} = 0 OR ${sources.isHidden} IS NULL)`;

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

export async function getEnrichableReleases(
  sourceId: string,
  sourceSlug?: string,
  limit?: number,
): Promise<Release[]> {
  if (isRemoteMode() && sourceSlug) {
    return apiClient.getEnrichableReleases(sourceSlug, limit);
  }
  const db = getDb();
  const query = db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.sourceId, sourceId),
        isNotNull(releases.url),
        eq(releases.suppressed, false),
      ),
    )
    .orderBy(desc(releases.publishedAt));
  if (limit) return query.limit(limit);
  return query;
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
      media: releases.media,
      publishedAt: releases.publishedAt,
      suppressed: releases.suppressed,
      suppressedReason: releases.suppressedReason,
      fetchedAt: releases.fetchedAt,
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

export interface SourceWithOrg {
  id: string;
  name: string;
  slug: string;
  type: string;
  url: string;
  lastFetchedAt: string | null;
  orgName: string | null;
  productName: string | null;
  productSlug: string | null;
  metadata: string | null;
  isPrimary: boolean;
  isHidden?: boolean | null;
}

export async function listSourcesWithOrg(opts?: {
  orgSlug?: string;
  productSlug?: string;
  hasFeed?: boolean;
  enrichable?: boolean;
  query?: string;
  includeHidden?: boolean;
  category?: string;
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

  if (opts?.hasFeed || opts?.enrichable) {
    conditions.push(
      sql`json_extract(${sources.metadata}, '$.feedUrl') IS NOT NULL AND json_extract(${sources.metadata}, '$.feedUrl') != ''`,
    );
  }

  if (opts?.enrichable) {
    conditions.push(
      sql`(json_extract(${sources.metadata}, '$.feedContentDepth') IS NULL OR json_extract(${sources.metadata}, '$.feedContentDepth') = 'summary-only')`,
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
      orgName: organizations.name,
      productName: products.name,
      productSlug: products.slug,
      metadata: sources.metadata,
      isPrimary: sql<boolean>`coalesce(${sources.isPrimary}, 0)`.as("isPrimary"),
      isHidden: sources.isHidden,
    })
    .from(sources)
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .leftJoin(products, eq(sources.productId, products.id));

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
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
    const orgSources = await db.select({ id: sources.id }).from(sources).where(and(eq(sources.orgId, org.id), notDisabled));
    orgSourceIds = orgSources.map((s) => s.id);
    if (orgSourceIds.length === 0) return [];
  }

  let query = db
    .select({
      id: releases.id,
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
    query = query.where(and(eq(releases.suppressed, false), notDisabled)) as typeof query;
  }

  return query;
}

// ── Known releases for incremental parsing ──

export interface KnownRelease {
  version: string | null;
  title: string;
  publishedAt: string | null;
}

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

// ── Search ──

export async function unifiedSearch(
  query: string,
  limit: number,
  opts?: { org?: string },
): Promise<import("../api/types.js").UnifiedSearchResponse> {
  if (isRemoteMode()) {
    return apiClient.unifiedSearch(query, limit, opts);
  }
  const { unifiedSearchLocal } = await import("./fts.js");
  return { query, ...unifiedSearchLocal(query, limit, 0) };
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

export async function insertReleases(source: Source, rows: Array<{
  sourceId: string; version: string | null; title: string; content: string;
  url: string | null; contentHash: string | null; publishedAt: string | null;
  media?: string | null;
}>): Promise<number> {
  if (isRemoteMode()) {
    const result = await apiClient.insertReleasesBatch(source.slug, rows);
    return result.inserted;
  }
  const db = getDb();
  // Batch insert in chunks of 500 (SQLite variable limit).
  // On URL conflict, backfill content if the incoming row has non-empty content
  // and the existing row is empty (lets feed enrichment update sparse releases).
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const result = await db.insert(releases).values(chunk)
      .onConflictDoUpdate({
        target: [releases.sourceId, releases.url],
        set: {
          content: sql`CASE WHEN excluded.content != '' AND releases.content = '' THEN excluded.content ELSE releases.content END`,
          contentHash: sql`CASE WHEN excluded.content != '' AND releases.content = '' THEN excluded.content_hash ELSE releases.content_hash END`,
        },
        where: sql`excluded.content != '' AND releases.content = ''`,
      })
      .returning({ id: releases.id });
    inserted += result.length;
  }
  return inserted;
}

// ── Release CRUD (for `release` command) ──

export interface ReleaseWithSource {
  release: Release;
  sourceName: string | null;
  sourceSlug: string | null;
}

export async function getRelease(id: string): Promise<ReleaseWithSource | null> {
  if (isRemoteMode()) {
    const result = await apiClient.getRelease(id);
    if (!result) return null;
    const { sourceName, sourceSlug, ...rel } = result;
    return { release: rel as Release, sourceName, sourceSlug };
  }
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
  return rows[0];
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

export type UsageBreakdownRow = apiClient.UsageBreakdownRow;

export interface UsageStats {
  totals: { totalInput: number; totalOutput: number; count: number };
  byOperation: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  bySource: UsageBreakdownRow[];
}

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

// ── Knowledge Pages ──

export async function getKnowledgePageForOrg(orgId: string, orgSlug?: string): Promise<KnowledgePage | null> {
  if (isRemoteMode() && orgSlug) {
    return apiClient.getKnowledgePage("org", orgSlug);
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, orgId)));
  return row ?? null;
}

export async function getKnowledgePageForProduct(productId: string, productSlug?: string): Promise<KnowledgePage | null> {
  if (isRemoteMode() && productSlug) {
    return apiClient.getKnowledgePage("product", productSlug);
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "product"), eq(knowledgePages.productId, productId)));
  return row ?? null;
}

export async function getSourceGuideForOrg(orgId: string, orgSlug?: string): Promise<KnowledgePage | null> {
  if (isRemoteMode() && orgSlug) {
    return apiClient.getKnowledgePage("source-guide", orgSlug);
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "source-guide"), eq(knowledgePages.orgId, orgId)));
  return row ?? null;
}

export async function upsertKnowledgePage(
  data: { scope: "org" | "product" | "source-guide"; orgId?: string | null; productId?: string | null; content: string; notes?: string | null; releaseCount: number; lastContributingReleaseAt?: string | null },
): Promise<void> {
  if (isRemoteMode()) {
    return apiClient.upsertKnowledgePage(data);
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

export async function updateSourceGuideNotes(orgId: string, orgSlug: string, notes: string): Promise<void> {
  if (isRemoteMode()) {
    return apiClient.updateSourceGuideNotes(orgSlug, notes);
  }
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .update(knowledgePages)
    .set({ notes: notes.trim() || null, updatedAt: now })
    .where(and(eq(knowledgePages.scope, "source-guide"), eq(knowledgePages.orgId, orgId)));
}

// ── Media Assets ──

import type { UploadResult } from "../lib/media.js";

export interface MediaAssetInput extends UploadResult {
  sourceId?: string | null;
  releaseId?: string | null;
}

/** Insert media assets, deduplicating by content_hash. Returns count of newly inserted rows. */
export async function insertMediaAssets(assets: MediaAssetInput[]): Promise<number> {
  if (assets.length === 0) return 0;

  if (isRemoteMode()) {
    const result = await apiClient.insertMediaAssets(assets);
    return result.inserted;
  }

  const db = getDb();
  let inserted = 0;
  for (let i = 0; i < assets.length; i += 500) {
    const chunk = assets.slice(i, i + 500);
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
