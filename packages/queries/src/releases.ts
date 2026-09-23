/**
 * Release reads shared by the API and MCP workers.
 *
 * Visibility follows the API: suppressed and coverage-side releases are
 * excluded (`releases_visible`), sources come from `sources_active` /
 * `sources_visible`, products from `products_active`, and releases under a
 * hidden or soft-deleted org are dropped from feeds.
 */
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  organizations,
  organizationsActive,
  productsActive,
  releases,
  releasesVisible,
  sourcesActive,
  sourcesVisible,
  type ReleaseType,
} from "@buildinternet/releases-core/schema";
import type { FeedCursorKey } from "@releases/core-internal/feed-cursor";
import type { AnyDb } from "@releases/lib/db";
import { githubHandleSubquery } from "./sql-fragments.js";

/**
 * One release by typed `rel_` ID with its source, org, and product, as the
 * `GET /v1/releases/:id` detail and MCP `get_release` read it.
 *
 * Returns null when the release is suppressed, coverage-side, or its source
 * is missing, hidden, or soft-deleted. A soft-deleted org or product leaves
 * the release readable but nulls the parent's columns. A hidden org still
 * resolves (`orgIsHidden` tells the caller).
 */
export async function findVisibleReleaseDetail(db: AnyDb, id: string) {
  const [row] = await db
    .select({
      release: releases,
      sourceName: sourcesVisible.name,
      sourceSlug: sourcesVisible.slug,
      sourceType: sourcesVisible.type,
      sourceMetadata: sourcesVisible.metadata,
      sourceIsHidden: sourcesVisible.isHidden,
      orgSlug: organizationsActive.slug,
      orgName: organizationsActive.name,
      orgAvatarUrl: organizationsActive.avatarUrl,
      orgDiscovery: organizationsActive.discovery,
      orgIsHidden: organizationsActive.isHidden,
      orgGithubHandle: githubHandleSubquery(sql`${organizationsActive.id}`),
      productSlug: productsActive.slug,
      productName: productsActive.name,
    })
    .from(releases)
    .innerJoin(sourcesVisible, eq(releases.sourceId, sourcesVisible.id))
    .leftJoin(organizationsActive, eq(sourcesVisible.orgId, organizationsActive.id))
    .leftJoin(productsActive, eq(sourcesVisible.productId, productsActive.id))
    .where(and(eq(releases.id, id), sql`${releases.id} IN (SELECT id FROM releases_visible)`))
    .limit(1);
  return row ?? null;
}

export interface LatestReleasesQuery {
  /** Restrict to these source IDs (product / source scope). */
  sourceIds?: string[];
  /** Restrict to one org's sources. */
  orgId?: string;
  type?: ReleaseType;
  /** Kind via source → product inheritance: `COALESCE(source.kind, product.kind)`. */
  kind?: string;
  since?: string;
  until?: string;
  minImportance?: number;
  /** Read the base `releases` table instead of `releases_visible`. */
  includeCoverage?: boolean;
  includePrereleases?: boolean;
  /** Drop releases dated after this ISO instant (future-dated guardrail). */
  notAfter?: string;
  /** Drop releases whose source type is in this list. */
  excludeSourceTypes?: string[];
  /** Select `content` (MCP renders it; the REST feed doesn't ship it). */
  includeContent?: boolean;
  /**
   * Keyset position from a `publishedAt|fetchedAt|id` feed cursor
   * (`parseFeedCursorKey` in `@releases/core-internal/feed-cursor`).
   */
  after?: FeedCursorKey | null;
  limit: number;
}

/**
 * Keyset predicate for the feed order (dated rows first, then
 * `published_at, fetched_at, id` descending). Same rules as
 * `feedCursorSql`: a dated cursor also admits every undated row; an undated
 * cursor admits only undated rows.
 */
function afterFeedKey(r: typeof releases | typeof releasesVisible, key: FeedCursorKey) {
  const { publishedAt: pub, fetchedAt: fet, id } = key;
  const undated = isNull(r.publishedAt);
  // Rows after the cursor among those sharing its published_at (or all
  // undated rows, when the cursor is in the undated tail).
  let tie: SQL | undefined;
  if (fet && id) tie = or(lt(r.fetchedAt, fet), and(eq(r.fetchedAt, fet), lt(r.id, id)));
  else if (id) tie = lt(r.id, id);

  if (!pub) return and(undated, tie);
  return or(undated, lt(r.publishedAt, pub), tie ? and(eq(r.publishedAt, pub), tie) : undefined);
}

/**
 * Cross-source latest-releases feed, read by `GET /v1/releases/latest` and
 * MCP `get_latest_releases`. Newest first: dated rows before undated, then
 * `published_at, fetched_at, id` descending, the order every REST feed and
 * `buildFeedCursor` use.
 *
 * Hidden or soft-deleted sources, soft-deleted products, and releases whose
 * org is hidden or soft-deleted are all excluded. An orphan source with no
 * org row still passes (org columns come back null).
 */
export async function listLatestReleases(db: AnyDb, q: LatestReleasesQuery) {
  const r = q.includeCoverage ? releases : releasesVisible;
  const s = sourcesActive;
  const p = productsActive;
  const o = organizations;

  const conds: (SQL | undefined)[] = [
    sql`(${s.isHidden} = 0 OR ${s.isHidden} IS NULL)`,
    sql`(${o.isHidden} = 0 OR ${o.isHidden} IS NULL)`,
    isNull(o.deletedAt),
    sql`(${r.suppressed} IS NULL OR ${r.suppressed} = 0)`,
  ];
  if (!q.includePrereleases) conds.push(sql`(${r.prerelease} IS NULL OR ${r.prerelease} = 0)`);
  if (q.notAfter) conds.push(or(lte(r.publishedAt, q.notAfter), isNull(r.publishedAt)));
  if (q.sourceIds) conds.push(inArray(r.sourceId, q.sourceIds));
  if (q.orgId) conds.push(eq(s.orgId, q.orgId));
  if (q.type) conds.push(eq(r.type, q.type));
  // `gte`/`lte` against the ISO text column drop NULL-dated rows.
  if (q.since) conds.push(gte(r.publishedAt, q.since));
  if (q.until) conds.push(lte(r.publishedAt, q.until));
  if (q.minImportance !== undefined) conds.push(gte(r.importance, q.minImportance));
  if (q.kind) conds.push(sql`COALESCE(${s.kind}, ${p.kind}) = ${q.kind}`);
  if (q.excludeSourceTypes && q.excludeSourceTypes.length > 0) {
    conds.push(notInArray(s.type, q.excludeSourceTypes as (typeof s.type._.data)[]));
  }
  if (q.after) conds.push(afterFeedKey(r, q.after));

  return db
    .select({
      id: r.id,
      title: r.title,
      version: r.version,
      type: r.type,
      content: q.includeContent ? r.content : sql<string | null>`NULL`,
      summary: r.summary,
      importance: r.importance,
      breaking: r.breaking,
      titleGenerated: r.titleGenerated,
      titleShort: r.titleShort,
      publishedAt: r.publishedAt,
      fetchedAt: r.fetchedAt,
      url: r.url,
      media: r.media,
      contentChars: r.contentChars,
      contentTokens: r.contentTokens,
      coverageCount: sql<number>`(SELECT COUNT(*) FROM release_coverage WHERE canonical_id = ${r.id})`,
      sourceName: s.name,
      sourceSlug: s.slug,
      sourceType: s.type,
      sourceKind: s.kind,
      orgName: o.name,
      orgSlug: o.slug,
      orgAvatarUrl: o.avatarUrl,
      orgGithubHandle: githubHandleSubquery(sql`${o.id}`),
      productName: p.name,
      productSlug: p.slug,
      productKind: p.kind,
    })
    .from(r)
    .innerJoin(s, eq(r.sourceId, s.id))
    .leftJoin(p, eq(s.productId, p.id))
    .leftJoin(o, eq(s.orgId, o.id))
    .where(and(...conds))
    .orderBy(
      sql`CASE WHEN ${r.publishedAt} IS NOT NULL THEN 0 ELSE 1 END`,
      desc(r.publishedAt),
      desc(r.fetchedAt),
      desc(r.id),
    )
    .limit(q.limit);
}
