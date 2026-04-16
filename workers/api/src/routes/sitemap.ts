import { Hono } from "hono";
import { eq, inArray, max, and, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { organizations, sources, products, releases } from "@releases/core/schema";
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
    .leftJoin(sources, eq(sources.orgId, organizations.id))
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
      .where(inArray(sources.orgId, orgIds)),

    db
      .select({
        orgId: products.orgId,
        slug: products.slug,
      })
      .from(products)
      .where(inArray(products.orgId, orgIds)),

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

  const orgIdToSlug = new Map(orgRows.map((o) => [o.id, o.slug] as const));

  const orgs = orgRows.map((o) => ({
    slug: o.slug,
    lastActivity: o.lastActivity ?? null,
  }));

  const sourcesOut = sourceRows
    .filter((s) => !s.isHidden)
    .map((s) => ({
      orgSlug: orgIdToSlug.get(s.orgId!) ?? null,
      slug: s.slug,
      latestDate: latestBySource.get(s.id) ?? null,
    }))
    .filter((s) => s.orgSlug !== null);

  const productsOut = productRows.map((p) => ({
    orgSlug: orgIdToSlug.get(p.orgId) ?? null,
    slug: p.slug,
  })).filter((p) => p.orgSlug !== null);

  return c.json({ orgs, sources: sourcesOut, products: productsOut });
});
