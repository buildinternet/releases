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
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import { orgWhere } from "../utils.js";
import type { Env } from "../index.js";

export const adminOrgDependentsRoutes = new Hono<Env>();

function getDb(c: Context<Env>): ReturnType<typeof createDb> {
  return (c.get("db" as never) as ReturnType<typeof createDb> | undefined) ?? createDb(c.env.DB);
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

  // Per-source counts collapse to zero when no sources exist; webhooks are
  // org-scoped (sourceId is nullable) so they're queried independently — an
  // org with zero sources can still hold subscriptions, and the hard-delete
  // cascade via webhook_subscriptions.org_id wipes them.
  const sub = sql`(SELECT id FROM sources WHERE org_id = ${org.id})`;
  const perSource =
    sourceCount > 0
      ? (
          (await db.all(sql`
          SELECT
            (SELECT COUNT(*) FROM releases WHERE source_id IN ${sub}) AS releases,
            (SELECT COUNT(*) FROM fetch_log WHERE source_id IN ${sub}) AS fetchLog,
            (SELECT COUNT(*) FROM source_changelog_files WHERE source_id IN ${sub}) AS sourceChangelogFiles,
            (SELECT COUNT(*) FROM source_changelog_chunks WHERE source_id IN ${sub}) AS sourceChangelogChunks,
            (SELECT COUNT(*) FROM release_summaries WHERE source_id IN ${sub}) AS releaseSummaries,
            (SELECT COUNT(*) FROM media_assets WHERE source_id IN ${sub}) AS mediaAssets
        `)) as Array<Omit<DependentCountsRow, "webhookSubscriptions">>
        )[0]
      : undefined;

  const [webhookRow] = (await db.all(sql`
    SELECT COUNT(*) AS n FROM webhook_subscriptions WHERE org_id = ${org.id}
  `)) as Array<{ n: number }>;

  const counts: DependentCountsRow = {
    releases: Number(perSource?.releases ?? 0),
    fetchLog: Number(perSource?.fetchLog ?? 0),
    sourceChangelogFiles: Number(perSource?.sourceChangelogFiles ?? 0),
    sourceChangelogChunks: Number(perSource?.sourceChangelogChunks ?? 0),
    releaseSummaries: Number(perSource?.releaseSummaries ?? 0),
    mediaAssets: Number(perSource?.mediaAssets ?? 0),
    webhookSubscriptions: Number(webhookRow?.n ?? 0),
  };

  return c.json({
    org: { id: org.id, slug: org.slug, name: org.name },
    counts: {
      sources: sourceCount,
      ...counts,
    },
  });
});
