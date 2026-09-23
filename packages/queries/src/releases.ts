/**
 * Release reads shared by the API and MCP workers.
 *
 * Visibility follows the API: suppressed and coverage-side releases are
 * excluded (`releases_visible`), sources come from `sources_active` /
 * `sources_visible`, products from `products_active`, and releases under a
 * hidden or soft-deleted org are dropped from feeds.
 */
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
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
  /** Keyset position for `(published_at DESC, id DESC)` paging. */
  after?: { lastPublishedAt: string | null; lastId: string } | null;
  limit: number;
}

/**
 * Cross-source latest-releases feed, newest first by `(published_at, id)`.
 * Visibility matches the API's `getLatestReleasesAcross`: hidden or
 * soft-deleted sources, soft-deleted products, and releases whose org is
 * hidden or soft-deleted are all excluded. An orphan source with no org row
 * still passes (org columns come back null), as in the API.
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
  if (q.after) {
    const { lastPublishedAt, lastId } = q.after;
    conds.push(
      lastPublishedAt
        ? or(
            lt(r.publishedAt, lastPublishedAt),
            and(eq(r.publishedAt, lastPublishedAt), lt(r.id, lastId)),
          )
        : // Null-published releases sort to the tail; compare by id alone there.
          lt(r.id, lastId),
    );
  }

  return db
    .select({
      id: r.id,
      title: r.title,
      version: r.version,
      type: r.type,
      content: r.content,
      summary: r.summary,
      importance: r.importance,
      titleGenerated: r.titleGenerated,
      titleShort: r.titleShort,
      publishedAt: r.publishedAt,
      url: r.url,
      contentChars: r.contentChars,
      contentTokens: r.contentTokens,
      sourceName: s.name,
      sourceSlug: s.slug,
      sourceType: s.type,
      orgName: o.name,
      orgSlug: o.slug,
      orgAvatarUrl: o.avatarUrl,
      orgGithubHandle: githubHandleSubquery(sql`${o.id}`),
      productName: p.name,
      productSlug: p.slug,
    })
    .from(r)
    .innerJoin(s, eq(r.sourceId, s.id))
    .leftJoin(p, eq(s.productId, p.id))
    .leftJoin(o, eq(s.orgId, o.id))
    .where(and(...conds))
    .orderBy(desc(r.publishedAt), desc(r.id))
    .limit(q.limit);
}
