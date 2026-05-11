import { Hono } from "hono";
import { eq, inArray, max, and, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  organizationsActive,
  sourcesActive,
  productsActive,
  releases,
  releaseSummaries,
  sourceChangelogFiles,
  collections,
} from "@buildinternet/releases-core/schema";
import type { Env } from "../index.js";

export const sitemapRoutes = new Hono<Env>();

sitemapRoutes.get("/sitemap", async (c) => {
  const db = createDb(c.env.DB);

  const orgRows = await db
    .select({
      id: organizationsActive.id,
      slug: organizationsActive.slug,
      lastActivity: max(sourcesActive.lastFetchedAt),
    })
    .from(organizationsActive)
    .leftJoin(sourcesActive, eq(sourcesActive.orgId, organizationsActive.id))
    .groupBy(organizationsActive.id);

  // Collections are independent of orgs (they reference orgs but live as
  // their own top-level resource), so always pull them — even when no orgs
  // exist (a fresh staging DB shouldn't drop the curated collection list).
  const collectionRows = await db
    .select({ slug: collections.slug, updatedAt: collections.updatedAt })
    .from(collections)
    .orderBy(collections.slug);

  if (orgRows.length === 0) {
    return c.json({ orgs: [], sources: [], products: [], collections: collectionRows });
  }

  const orgIds = orgRows.map((o) => o.id);

  // D1 caps prepared statements at 100 bound parameters; with hundreds of
  // orgs an unchunked inArray would 500. Chunk to 90 and concat results.
  const ORG_ID_CHUNK = 90;
  const orgIdChunks: string[][] = [];
  for (let i = 0; i < orgIds.length; i += ORG_ID_CHUNK) {
    orgIdChunks.push(orgIds.slice(i, i + ORG_ID_CHUNK));
  }

  const [
    sourceRowsByChunk,
    productRowsByChunk,
    latestReleaseRowsByChunk,
    summarySourceIdsByChunk,
    changelogSourceIdsByChunk,
  ] = await Promise.all([
    Promise.all(
      orgIdChunks.map((chunk) =>
        db
          .select({
            orgId: sourcesActive.orgId,
            slug: sourcesActive.slug,
            id: sourcesActive.id,
            isHidden: sourcesActive.isHidden,
          })
          .from(sourcesActive)
          .where(inArray(sourcesActive.orgId, chunk)),
      ),
    ),
    Promise.all(
      orgIdChunks.map((chunk) =>
        db
          .select({
            orgId: productsActive.orgId,
            slug: productsActive.slug,
          })
          .from(productsActive)
          .where(inArray(productsActive.orgId, chunk)),
      ),
    ),
    Promise.all(
      orgIdChunks.map((chunk) =>
        db
          .select({
            sourceId: releases.sourceId,
            latestDate: max(releases.publishedAt),
          })
          .from(releases)
          .innerJoin(sourcesActive, eq(releases.sourceId, sourcesActive.id))
          .where(and(inArray(sourcesActive.orgId, chunk), sql`${releases.publishedAt} IS NOT NULL`))
          .groupBy(releases.sourceId),
      ),
    ),
    Promise.all(
      orgIdChunks.map((chunk) =>
        db
          .selectDistinct({ sourceId: releaseSummaries.sourceId })
          .from(releaseSummaries)
          .innerJoin(sourcesActive, eq(releaseSummaries.sourceId, sourcesActive.id))
          .where(inArray(sourcesActive.orgId, chunk)),
      ),
    ),
    Promise.all(
      orgIdChunks.map((chunk) =>
        db
          .selectDistinct({ sourceId: sourceChangelogFiles.sourceId })
          .from(sourceChangelogFiles)
          .innerJoin(sourcesActive, eq(sourceChangelogFiles.sourceId, sourcesActive.id))
          .where(inArray(sourcesActive.orgId, chunk)),
      ),
    ),
  ]);

  const sourceRows = sourceRowsByChunk.flat();
  const productRows = productRowsByChunk.flat();
  const latestReleaseRows = latestReleaseRowsByChunk.flat();
  const sourcesWithSummaries = new Set(summarySourceIdsByChunk.flat().map((r) => r.sourceId));
  const sourcesWithChangelog = new Set(changelogSourceIdsByChunk.flat().map((r) => r.sourceId));

  const latestBySource = new Map<string, string>();
  for (const row of latestReleaseRows) {
    if (row.latestDate) latestBySource.set(row.sourceId, row.latestDate);
  }

  const orgIdToSlug = new Map(orgRows.map((o) => [o.id, o.slug]));

  const orgs = orgRows.map((o) => ({
    slug: o.slug,
    lastActivity: o.lastActivity ?? null,
  }));

  // Every row here was fetched via inArray(orgId, orgIds) so orgIdToSlug.get
  // is guaranteed to resolve — flatMap lets us skip hidden rows in one pass.
  const sourcesOut = sourceRows.flatMap((s) =>
    s.isHidden || !s.orgId
      ? []
      : [
          {
            orgSlug: orgIdToSlug.get(s.orgId)!,
            slug: s.slug,
            latestDate: latestBySource.get(s.id) ?? null,
            hasChangelog: sourcesWithChangelog.has(s.id),
            hasHighlights: sourcesWithSummaries.has(s.id),
          },
        ],
  );

  const productsOut = productRows.flatMap((p) =>
    !p.orgId ? [] : [{ orgSlug: orgIdToSlug.get(p.orgId)!, slug: p.slug }],
  );

  return c.json({
    orgs,
    sources: sourcesOut,
    products: productsOut,
    collections: collectionRows,
  });
});
