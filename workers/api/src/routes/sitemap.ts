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

  const [sourceRows, productRows, latestReleaseRows] = await Promise.all([
    db
      .select({
        orgId: sources.orgId,
        slug: sources.slug,
        id: sources.id,
        isHidden: sources.isHidden,
      })
      .from(sources)
      .where(and(inArray(sources.orgId, orgIds), sourceNotDeleted)),

    db
      .select({
        orgId: products.orgId,
        slug: products.slug,
      })
      .from(products)
      .where(and(inArray(products.orgId, orgIds), productNotDeleted)),

    db
      .select({
        sourceId: releases.sourceId,
        latestDate: max(releases.publishedAt),
      })
      .from(releases)
      .innerJoin(sources, eq(releases.sourceId, sources.id))
      .where(and(inArray(sources.orgId, orgIds), sql`${releases.publishedAt} IS NOT NULL`))
      .groupBy(releases.sourceId),
  ]);

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
