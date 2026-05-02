import { Hono } from "hono";
import { eq, inArray, max, and, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { organizations, sources, products, releases } from "@buildinternet/releases-core/schema";
import { orgNotDeleted, productNotDeleted, sourceNotDeleted } from "../queries/shared.js";
import type { Env } from "../index.js";

export const sitemapRoutes = new Hono<Env>();

sitemapRoutes.get("/sitemap", async (c) => {
  const db = createDb(c.env.DB);

  const orgRows = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      lastActivity: max(sources.lastFetchedAt),
    })
    .from(organizations)
    .leftJoin(sources, and(eq(sources.orgId, organizations.id), sourceNotDeleted))
    .where(orgNotDeleted)
    .groupBy(organizations.id);

  if (orgRows.length === 0) {
    return c.json({ orgs: [], sources: [], products: [] });
  }

  const orgIds = orgRows.map((o) => o.id);

  // D1 caps prepared statements at 100 bound parameters; with hundreds of
  // orgs an unchunked inArray would 500. Chunk to 90 and concat results.
  const ORG_ID_CHUNK = 90;
  const orgIdChunks: string[][] = [];
  for (let i = 0; i < orgIds.length; i += ORG_ID_CHUNK) {
    orgIdChunks.push(orgIds.slice(i, i + ORG_ID_CHUNK));
  }

  const [sourceRowsByChunk, productRowsByChunk, latestReleaseRowsByChunk] = await Promise.all([
    Promise.all(
      orgIdChunks.map((chunk) =>
        db
          .select({
            orgId: sources.orgId,
            slug: sources.slug,
            id: sources.id,
            isHidden: sources.isHidden,
          })
          .from(sources)
          .where(and(inArray(sources.orgId, chunk), sourceNotDeleted)),
      ),
    ),
    Promise.all(
      orgIdChunks.map((chunk) =>
        db
          .select({
            orgId: products.orgId,
            slug: products.slug,
          })
          .from(products)
          .where(and(inArray(products.orgId, chunk), productNotDeleted)),
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
          .innerJoin(sources, eq(releases.sourceId, sources.id))
          .where(
            and(
              inArray(sources.orgId, chunk),
              sourceNotDeleted,
              sql`${releases.publishedAt} IS NOT NULL`,
            ),
          )
          .groupBy(releases.sourceId),
      ),
    ),
  ]);

  const sourceRows = sourceRowsByChunk.flat();
  const productRows = productRowsByChunk.flat();
  const latestReleaseRows = latestReleaseRowsByChunk.flat();

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
          },
        ],
  );

  const productsOut = productRows.flatMap((p) =>
    !p.orgId ? [] : [{ orgSlug: orgIdToSlug.get(p.orgId)!, slug: p.slug }],
  );

  return c.json({ orgs, sources: sourcesOut, products: productsOut });
});
