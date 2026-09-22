/**
 * Sources opted into the marketing classifier (`metadata.marketingFilter =
 * true`). Backs the `/v1/admin/marketing-classifier` GET route's `sources`
 * list — operators toggle the filter per source via the existing source PATCH
 * route (`PATCH /v1/sources/:id`), not through this query.
 */
import { desc, eq, sql } from "drizzle-orm";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import type { AnyDb } from "../db.js";

export interface MarketingFilteredSource {
  id: string;
  slug: string;
  name: string;
  type: string;
  orgSlug: string | null;
  hint: string | null;
  recentReleaseCount: number;
}

/** Recent-release window for the (cheap, indexed) per-source count. */
const RECENT_RELEASE_DAYS = 30;

export async function getMarketingFilteredSources(db: AnyDb): Promise<MarketingFilteredSource[]> {
  const rows = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      name: sources.name,
      type: sources.type,
      orgSlug: organizations.slug,
      metadata: sources.metadata,
    })
    .from(sources)
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .where(sql`json_extract(${sources.metadata}, '$.marketingFilter') = 1`)
    .orderBy(desc(sources.lastFetchedAt));

  const countBySource = new Map<string, number>();
  if (rows.length > 0) {
    const cutoff = new Date(Date.now() - RECENT_RELEASE_DAYS * 86_400_000).toISOString();
    const counts = await db
      .select({ sourceId: releases.sourceId, count: sql<number>`count(*)` })
      .from(releases)
      .where(
        sql`${releases.sourceId} IN (${sql.join(
          rows.map((r: { id: string }) => sql`${r.id}`),
          sql`, `,
        )}) AND ${releases.publishedAt} >= ${cutoff}`,
      )
      .groupBy(releases.sourceId);
    for (const c of counts as Array<{ sourceId: string; count: number }>) {
      countBySource.set(c.sourceId, c.count);
    }
  }

  return rows.map((row: (typeof rows)[number]) => {
    let hint: string | null = null;
    try {
      const parsed = JSON.parse(row.metadata ?? "{}");
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.marketingFilterHint === "string"
      ) {
        hint = parsed.marketingFilterHint;
      }
    } catch {
      hint = null;
    }
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      type: row.type,
      orgSlug: row.orgSlug ?? null,
      hint,
      recentReleaseCount: countBySource.get(row.id) ?? 0,
    };
  });
}
