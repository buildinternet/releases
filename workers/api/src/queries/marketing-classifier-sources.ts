/**
 * Sources opted into the marketing classifier (`metadata.marketingFilter =
 * true`). Backs the `/v1/admin/marketing-classifier` GET route's `sources`
 * list — operators toggle the filter per source via the existing source PATCH
 * route (`PATCH /v1/sources/:id`), not through this query.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import type { AnyDb } from "../db.js";
import { IN_ARRAY_CHUNK_SIZE, chunkArray } from "../lib/d1-limits.js";

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
  const cutoff = daysAgoIso(RECENT_RELEASE_DAYS);
  const countChunks = await Promise.all(
    chunkArray(
      rows.map((r: { id: string }) => r.id),
      IN_ARRAY_CHUNK_SIZE,
    ).map((ids) =>
      db
        .select({ sourceId: releases.sourceId, count: sql<number>`count(*)` })
        .from(releases)
        .where(and(inArray(releases.sourceId, ids), gte(releases.publishedAt, cutoff)))
        .groupBy(releases.sourceId),
    ),
  );
  for (const c of countChunks.flat() as Array<{ sourceId: string; count: number }>) {
    countBySource.set(c.sourceId, c.count);
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
