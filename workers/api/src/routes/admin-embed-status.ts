// Telemetry endpoint for semantic-search backfill progress: per-table
// embedded vs unembedded counts. Auth-gated via the `admin/embed/status`
// entry in the adminRoutes allowlist in workers/api/src/index.ts.

import { Hono } from "hono";
import { and, count, isNull, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  releases,
  sources,
  organizations,
  products,
  sourceChangelogChunks,
} from "@buildinternet/releases-core/schema";
import type { Env } from "../index.js";

export const adminEmbedStatusRoutes = new Hono<Env>();

// ── GET /admin/embed/status ───────────────────────────────────────────────

adminEmbedStatusRoutes.get("/admin/embed/status", async (c) => {
  const db = createDb(c.env.DB);

  const [
    [releasesTotal],
    [releasesEmbedded],
    [orgsTotal],
    [orgsEmbedded],
    [productsTotal],
    [productsEmbedded],
    [sourcesTotal],
    [sourcesEmbedded],
    [chunksTotal],
    [chunksEmbedded],
  ] = await Promise.all([
    db.select({ n: count() }).from(releases),
    db
      .select({ n: count() })
      .from(releases)
      // Suppressed rows are still counted — the backfill treats them the
      // same; operators who care about suppressed gaps diff against search.
      .where(and(sql`${releases.embeddedAt} IS NOT NULL`)),
    db.select({ n: count() }).from(organizations).where(isNull(organizations.deletedAt)),
    db
      .select({ n: count() })
      .from(organizations)
      .where(and(isNull(organizations.deletedAt), sql`${organizations.embeddedAt} IS NOT NULL`)),
    db.select({ n: count() }).from(products).where(isNull(products.deletedAt)),
    db
      .select({ n: count() })
      .from(products)
      .where(and(isNull(products.deletedAt), sql`${products.embeddedAt} IS NOT NULL`)),
    db.select({ n: count() }).from(sources).where(isNull(sources.deletedAt)),
    db
      .select({ n: count() })
      .from(sources)
      .where(and(isNull(sources.deletedAt), sql`${sources.embeddedAt} IS NOT NULL`)),
    db.select({ n: count() }).from(sourceChangelogChunks),
    db
      .select({ n: count() })
      .from(sourceChangelogChunks)
      .where(sql`${sourceChangelogChunks.vectorId} IS NOT NULL`),
  ]);

  const entitiesTotal = orgsTotal.n + productsTotal.n + sourcesTotal.n;
  const entitiesEmbedded = orgsEmbedded.n + productsEmbedded.n + sourcesEmbedded.n;

  return c.json({
    releases: {
      total: releasesTotal.n,
      embedded: releasesEmbedded.n,
      unembedded: releasesTotal.n - releasesEmbedded.n,
    },
    entities: {
      total: entitiesTotal,
      embedded: entitiesEmbedded,
      unembedded: entitiesTotal - entitiesEmbedded,
      breakdown: {
        org: {
          total: orgsTotal.n,
          embedded: orgsEmbedded.n,
          unembedded: orgsTotal.n - orgsEmbedded.n,
        },
        product: {
          total: productsTotal.n,
          embedded: productsEmbedded.n,
          unembedded: productsTotal.n - productsEmbedded.n,
        },
        source: {
          total: sourcesTotal.n,
          embedded: sourcesEmbedded.n,
          unembedded: sourcesTotal.n - sourcesEmbedded.n,
        },
      },
    },
    chunks: {
      total: chunksTotal.n,
      embedded: chunksEmbedded.n,
      unembedded: chunksTotal.n - chunksEmbedded.n,
    },
  });
});
