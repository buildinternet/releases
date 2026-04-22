/**
 * Telemetry endpoint for semantic-search backfill progress. Reports
 * per-table embedded vs unembedded counts so operators can assess
 * backfill status at a glance.
 *
 * Gated by `authMiddleware` via the `/admin/embed/status` entry in the
 * adminRoutes allowlist in workers/api/src/index.ts.
 *
 * The three backfill POST endpoints have moved to /v1/workflows/embed-*.
 */

import { Hono } from "hono";
import { and, count, sql } from "drizzle-orm";
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
      .where(
        and(
          // Embedded is simply "embedded_at IS NOT NULL" — suppressed rows are
          // still counted because the backfill treats them the same. Operators
          // who care about suppressed gaps can diff against the search paths.
          sql`${releases.embeddedAt} IS NOT NULL`,
        ),
      ),
    db.select({ n: count() }).from(organizations),
    db
      .select({ n: count() })
      .from(organizations)
      .where(sql`${organizations.embeddedAt} IS NOT NULL`),
    db.select({ n: count() }).from(products),
    db
      .select({ n: count() })
      .from(products)
      .where(sql`${products.embeddedAt} IS NOT NULL`),
    db.select({ n: count() }).from(sources),
    db
      .select({ n: count() })
      .from(sources)
      .where(sql`${sources.embeddedAt} IS NOT NULL`),
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
