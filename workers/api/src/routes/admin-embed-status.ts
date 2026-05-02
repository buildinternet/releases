// Telemetry endpoint for semantic-search backfill progress: per-table
// embedded vs unembedded counts. Auth-gated via the `admin/embed/status`
// entry in the adminRoutes allowlist in workers/api/src/index.ts.

import { Hono } from "hono";
import { count, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  releases,
  sourcesActive,
  organizationsActive,
  productsActive,
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
      .where(sql`${releases.embeddedAt} IS NOT NULL`),
    db.select({ n: count() }).from(organizationsActive),
    db
      .select({ n: count() })
      .from(organizationsActive)
      .where(sql`${organizationsActive.embeddedAt} IS NOT NULL`),
    db.select({ n: count() }).from(productsActive),
    db
      .select({ n: count() })
      .from(productsActive)
      .where(sql`${productsActive.embeddedAt} IS NOT NULL`),
    db.select({ n: count() }).from(sourcesActive),
    db
      .select({ n: count() })
      .from(sourcesActive)
      .where(sql`${sourcesActive.embeddedAt} IS NOT NULL`),
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
