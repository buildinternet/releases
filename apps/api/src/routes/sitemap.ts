import { resolveSourceDataset } from "@releases/core-internal/source-dataset";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { hideInProduction } from "../openapi.js";
import { eq, inArray, max, and, sql, count } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  organizationsPublic,
  sources,
  sourcesActive,
  productsActive,
  releases,
  releaseSummaries,
  sourceChangelogFiles,
  collections,
  collectionWeeklyDigests,
  knowledgePages,
} from "@buildinternet/releases-core/schema";
import { SitemapPayloadSchema } from "@buildinternet/releases-api-types";
import { PRODUCT_HAS_VISIBLE_SOURCE } from "@releases/queries/orgs";
import type { Env } from "../index.js";

export const sitemapRoutes = new Hono<Env>();

sitemapRoutes.get(
  "/sitemap",
  describeRoute({
    hide: hideInProduction,
    tags: ["Sitemap"],
    summary: "Bulk URL payload for the web sitemap generator",
    description:
      "Lists every visible org / source / product / collection slug paired with the timestamp the web uses to drive `<lastmod>`. Joined through `*_active` views, so soft-deleted and hidden (`is_hidden = 1`) rows are excluded; stub-tier orgs (#1947) are excluded too (their pages are `noindex`). Products are listed only when they have at least one visible source — the same definition as org detail (`PRODUCT_HAS_VISIBLE_SOURCE`) — so a product the org page hides never appears here. Orgs carry `releaseCount` and `hasOverview`, which the web uses to decide which org, product, and source pages are indexable. Sources also carry `hasChangelog` and `hasHighlights` flags (#875).\n\nOrg id lookups are chunked to 90 at a time to stay under D1's 100-bound-parameter cap on prepared statements.",
    responses: {
      200: {
        description: "Bulk URL payload",
        content: { "application/json": { schema: resolver(SitemapPayloadSchema) } },
      },
    },
  }),
  async (c) => {
    // Web caches this projection; an upstream HTTP cache would outlive operator revalidation.
    c.header("Cache-Control", "private, no-store");
    const db = createDb(c.env.DB);

    const orgRows = await db
      .select({
        id: organizationsPublic.id,
        slug: organizationsPublic.slug,
        lastActivity: max(sourcesActive.lastFetchedAt),
      })
      .from(organizationsPublic)
      .leftJoin(sourcesActive, eq(sourcesActive.orgId, organizationsPublic.id))
      // Stub orgs (#1947) are noindex thin pages — keep them out of the sitemap.
      // Dropping them from orgRows also drops their products/sources below, which
      // are keyed off this org-id set.
      .where(eq(organizationsPublic.tier, "tracked"))
      .groupBy(organizationsPublic.id);

    // Collections are independent of orgs (they reference orgs but live as
    // their own top-level resource), so always pull them — even when no orgs
    // exist (a fresh staging DB shouldn't drop the curated collection list).
    const collectionRows = await db
      .select({ slug: collections.slug, updatedAt: collections.updatedAt })
      .from(collections)
      .orderBy(collections.slug);

    // Weekly digests are their own permalinked pages (~600/yr at full scale)
    // — small enough to fold into the main sitemap payload rather than a
    // dedicated /sitemap/digests surface, mirroring the collections list above.
    const digestRows = await db
      .select({
        collectionSlug: collections.slug,
        weekStart: collectionWeeklyDigests.weekStart,
        generatedAt: collectionWeeklyDigests.generatedAt,
      })
      .from(collectionWeeklyDigests)
      .innerJoin(collections, eq(collections.id, collectionWeeklyDigests.collectionId))
      .orderBy(collections.slug, collectionWeeklyDigests.weekStart);

    if (orgRows.length === 0) {
      return c.json({
        orgs: [],
        sources: [],
        products: [],
        collections: collectionRows,
        digests: digestRows,
      });
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
      releaseCountRowsByChunk,
      overviewOrgIdsByChunk,
    ] = await Promise.all([
      Promise.all(
        orgIdChunks.map((chunk) =>
          db
            .select({
              orgId: sourcesActive.orgId,
              slug: sourcesActive.slug,
              id: sourcesActive.id,
              name: sourcesActive.name,
              metadata: sourcesActive.metadata,
              isHidden: sourcesActive.isHidden,
              discovery: sourcesActive.discovery,
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
              // Same per-product count as org detail (`listOrgVisibleProducts`).
              releaseCount: sql<number>`(SELECT COUNT(*) FROM releases_visible rv JOIN sources_visible sa ON sa.id = rv.source_id WHERE sa.product_id = products_active.id)`,
            })
            .from(productsActive)
            .where(and(inArray(productsActive.orgId, chunk), PRODUCT_HAS_VISIBLE_SOURCE)),
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
            .where(
              and(inArray(sourcesActive.orgId, chunk), sql`${releases.publishedAt} IS NOT NULL`),
            )
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
      // Per-org release total, counted the same way org detail counts its
      // `releaseCount` (every source, suppressed included) so the web's index
      // bar agrees between the page and the sitemap.
      Promise.all(
        orgIdChunks.map((chunk) =>
          db
            .select({ orgId: sources.orgId, n: count() })
            .from(releases)
            .innerJoin(sources, eq(releases.sourceId, sources.id))
            .where(inArray(sources.orgId, chunk))
            .groupBy(sources.orgId),
        ),
      ),
      Promise.all(
        orgIdChunks.map((chunk) =>
          db
            .selectDistinct({ orgId: knowledgePages.orgId })
            .from(knowledgePages)
            .where(and(eq(knowledgePages.scope, "org"), inArray(knowledgePages.orgId, chunk))),
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

    const releaseCountByOrg = new Map<string, number>();
    for (const row of releaseCountRowsByChunk.flat()) {
      if (row.orgId) releaseCountByOrg.set(row.orgId, row.n);
    }
    const orgsWithOverview = new Set(overviewOrgIdsByChunk.flat().map((r) => r.orgId));

    const orgs = orgRows.map((o) => ({
      slug: o.slug,
      lastActivity: o.lastActivity ?? null,
      releaseCount: releaseCountByOrg.get(o.id) ?? 0,
      hasOverview: orgsWithOverview.has(o.id),
    }));

    // Every row here was fetched via inArray(orgId, orgIds) so orgIdToSlug.get
    // is guaranteed to resolve — flatMap lets us skip hidden rows in one pass.
    const sourcesOut = sourceRows.flatMap((s) =>
      s.isHidden || s.discovery === "on_demand" || !s.orgId
        ? []
        : [
            {
              id: s.id,
              orgSlug: orgIdToSlug.get(s.orgId)!,
              slug: s.slug,
              latestDate: latestBySource.get(s.id) ?? null,
              dataset:
                resolveSourceDataset({
                  ...s,
                  isHidden: !!s.isHidden,
                  orgSlug: orgIdToSlug.get(s.orgId)!,
                }) ?? null,
              hasChangelog: sourcesWithChangelog.has(s.id),
              hasHighlights: sourcesWithSummaries.has(s.id),
            },
          ],
    );

    const productsOut = productRows.flatMap((p) =>
      !p.orgId
        ? []
        : [{ orgSlug: orgIdToSlug.get(p.orgId)!, slug: p.slug, releaseCount: p.releaseCount }],
    );

    return c.json({
      orgs,
      sources: sourcesOut,
      products: productsOut,
      collections: collectionRows,
      digests: digestRows,
    });
  },
);
