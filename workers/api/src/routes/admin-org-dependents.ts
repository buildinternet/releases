/**
 * Admin-only route that previews the cascade scope of `DELETE /v1/orgs/:slug?hard=true`.
 *
 * After #690 Phase C C1 flipped `sources.org_id` to ON DELETE CASCADE,
 * hard-deleting an org also drops every release / fetch_log / changelog row
 * tied to its sources. This endpoint returns the row counts that would be
 * removed so callers (CLI, web admin) can show a confirmation preview.
 *
 * Gated by `authMiddleware` via the `admin/orgs` entry in
 * workers/api/src/index.ts.
 */
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import { orgWhere } from "../utils.js";
import type { Env } from "../index.js";

export const adminOrgDependentsRoutes = new Hono<Env>();

function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

interface DependentCountsRow {
  releases: number;
  fetchLog: number;
  sourceChangelogFiles: number;
  sourceChangelogChunks: number;
  releaseSummaries: number;
  mediaAssets: number;
  webhookSubscriptions: number;
}

adminOrgDependentsRoutes.get("/admin/orgs/:slug/dependents", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");

  const includeDeleted = slug.startsWith("org_");
  const [org] = await db
    .select({ id: organizations.id, slug: organizations.slug, name: organizations.name })
    .from(organizations)
    .where(orgWhere(slug, { includeDeleted }));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  // Count sources first so dependent counts are reasoned about against the
  // same scope (sources tied to this org, including hidden/tombstoned —
  // hard-delete cascades regardless of soft-delete state).
  const [sourceCountRow] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(sources)
    .where(sql`${sources.orgId} = ${org.id}`);
  const sourceCount = Number(sourceCountRow?.n ?? 0);

  let counts: DependentCountsRow = {
    releases: 0,
    fetchLog: 0,
    sourceChangelogFiles: 0,
    sourceChangelogChunks: 0,
    releaseSummaries: 0,
    mediaAssets: 0,
    webhookSubscriptions: 0,
  };

  if (sourceCount > 0) {
    // Subquery used by every dependent count — kept literal so the hard-coded
    // table names match the actual FKs (the cascade target is `sources.org_id`).
    const sub = sql`(SELECT id FROM sources WHERE org_id = ${org.id})`;
    const rows = (await db.all(sql`
      SELECT
        (SELECT COUNT(*) FROM releases WHERE source_id IN ${sub}) AS releases,
        (SELECT COUNT(*) FROM fetch_log WHERE source_id IN ${sub}) AS fetchLog,
        (SELECT COUNT(*) FROM source_changelog_files WHERE source_id IN ${sub}) AS sourceChangelogFiles,
        (SELECT COUNT(*) FROM source_changelog_chunks WHERE source_id IN ${sub}) AS sourceChangelogChunks,
        (SELECT COUNT(*) FROM release_summaries WHERE source_id IN ${sub}) AS releaseSummaries,
        (SELECT COUNT(*) FROM media_assets WHERE source_id IN ${sub}) AS mediaAssets,
        (SELECT COUNT(*) FROM webhook_subscriptions WHERE source_id IN ${sub}) AS webhookSubscriptions
    `)) as DependentCountsRow[];
    const r = rows[0];
    if (r) {
      counts = {
        releases: Number(r.releases ?? 0),
        fetchLog: Number(r.fetchLog ?? 0),
        sourceChangelogFiles: Number(r.sourceChangelogFiles ?? 0),
        sourceChangelogChunks: Number(r.sourceChangelogChunks ?? 0),
        releaseSummaries: Number(r.releaseSummaries ?? 0),
        mediaAssets: Number(r.mediaAssets ?? 0),
        webhookSubscriptions: Number(r.webhookSubscriptions ?? 0),
      };
    }
  }

  return c.json({
    org: { id: org.id, slug: org.slug, name: org.name },
    counts: {
      sources: sourceCount,
      ...counts,
    },
  });
});
