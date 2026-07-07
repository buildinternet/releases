import DataLoader from "dataloader";
import { and, eq, inArray, isNull, lte, max, min, sql } from "drizzle-orm";
import {
  domainAliases,
  orgAccounts,
  orgTags,
  organizations,
  products,
  releases,
  releasesVisible,
  sources,
  sourcesVisible,
  tags,
} from "@buildinternet/releases-core/schema";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import type { D1Db } from "../db.js";
import { RELEASES_ID_IN_CHUNK_SIZE } from "../lib/d1-limits.js";
import { computeAvgPerWeek } from "../utils.js";
import { getOrgStatsByIds, getOrgSparklines } from "../queries/orgs.js";

type Org = typeof organizations.$inferSelect;
type Product = typeof products.$inferSelect;
type Source = typeof sources.$inferSelect;
type Release = typeof releasesVisible.$inferSelect;

export type Loaders = ReturnType<typeof createLoaders>;

/** Org-level aggregate stats — mirrors the REST `GET /v1/orgs/:slug` computation
 *  (`workers/api/src/routes/orgs.ts`). Batched by org id via one grouped query
 *  per stat family rather than N+1 per-org round trips. */
export type OrgStats = {
  releaseCount: number;
  releasesLast30Days: number;
  avgReleasesPerWeek: number;
  lastFetchedAt: string | null;
  lastPolledAt: string | null;
  trackingSince: string;
};

/** Per-source release aggregate — mirrors `getOrgSourcesWithStats`
 *  (`workers/api/src/queries/orgs.ts`), batched by source id. */
export type SourceStats = {
  releaseCount: number;
  latestVersion: string | null;
  latestDate: string | null;
  latestAddedAt: string | null;
};

// Per-source cap for `Source.releases`. Enforced inside the batch query via
// ROW_NUMBER() OVER (PARTITION BY source_id …) so each requested source gets
// its own slice — a tall source cannot starve shorter ones in the same batch.
const RECENT_RELEASE_CAP = 50;

async function chunkedFetch<K extends string, R>(
  keys: readonly K[],
  fetcher: (chunk: K[]) => Promise<R[]>,
): Promise<R[]> {
  if (keys.length <= RELEASES_ID_IN_CHUNK_SIZE) {
    return fetcher(keys as K[]);
  }
  const chunks: K[][] = [];
  for (let i = 0; i < keys.length; i += RELEASES_ID_IN_CHUNK_SIZE) {
    chunks.push(keys.slice(i, i + RELEASES_ID_IN_CHUNK_SIZE) as K[]);
  }
  const results = await Promise.all(chunks.map(fetcher));
  return results.flat();
}

export function createLoaders(db: D1Db) {
  return {
    orgById: new DataLoader<string, Org | null>(async (ids) => {
      const rows = await chunkedFetch(ids, (chunk) =>
        db
          .select()
          .from(organizations)
          .where(and(inArray(organizations.id, chunk), isNull(organizations.deletedAt))),
      );
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      return ids.map((id) => byId.get(id) ?? null);
    }),

    orgBySlug: new DataLoader<string, Org | null>(async (slugs) => {
      const rows = await chunkedFetch(slugs, (chunk) =>
        db
          .select()
          .from(organizations)
          .where(and(inArray(organizations.slug, chunk), isNull(organizations.deletedAt))),
      );
      const bySlug = new Map(rows.map((r) => [r.slug, r] as const));
      return slugs.map((s) => bySlug.get(s) ?? null);
    }),

    productById: new DataLoader<string, Product | null>(async (ids) => {
      const rows = await chunkedFetch(ids, (chunk) =>
        db
          .select()
          .from(products)
          .where(and(inArray(products.id, chunk), isNull(products.deletedAt))),
      );
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      return ids.map((id) => byId.get(id) ?? null);
    }),

    sourceById: new DataLoader<string, Source | null>(async (ids) => {
      const rows = await chunkedFetch(ids, (chunk) =>
        db
          .select()
          .from(sources)
          .where(and(inArray(sources.id, chunk), isNull(sources.deletedAt))),
      );
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      return ids.map((id) => byId.get(id) ?? null);
    }),

    productsByOrgId: new DataLoader<string, Product[]>(async (orgIds) => {
      const rows = await chunkedFetch(orgIds, (chunk) =>
        db
          .select()
          .from(products)
          .where(and(inArray(products.orgId, chunk), isNull(products.deletedAt))),
      );
      const grouped = new Map<string, Product[]>();
      for (const row of rows) {
        const list = grouped.get(row.orgId) ?? [];
        list.push(row);
        grouped.set(row.orgId, list);
      }
      return orgIds.map((id) => grouped.get(id) ?? []);
    }),

    sourcesByOrgId: new DataLoader<string, Source[]>(async (orgIds) => {
      const rows = await chunkedFetch(orgIds, (chunk) =>
        db
          .select()
          .from(sources)
          .where(
            and(
              inArray(sources.orgId, chunk),
              isNull(sources.deletedAt),
              eq(sources.isHidden, false),
            ),
          ),
      );
      const grouped = new Map<string, Source[]>();
      for (const row of rows) {
        const list = grouped.get(row.orgId) ?? [];
        list.push(row);
        grouped.set(row.orgId, list);
      }
      return orgIds.map((id) => grouped.get(id) ?? []);
    }),

    sourcesByProductId: new DataLoader<string, Source[]>(async (productIds) => {
      const rows = await chunkedFetch(productIds, (chunk) =>
        db
          .select()
          .from(sources)
          .where(
            and(
              inArray(sources.productId, chunk),
              isNull(sources.deletedAt),
              eq(sources.isHidden, false),
            ),
          ),
      );
      const grouped = new Map<string, Source[]>();
      for (const row of rows) {
        if (!row.productId) continue;
        const list = grouped.get(row.productId) ?? [];
        list.push(row);
        grouped.set(row.productId, list);
      }
      return productIds.map((id) => grouped.get(id) ?? []);
    }),

    // Reads through `releases_visible` so suppressed AND coverage-side rows
    // are filtered to match REST's public surfaces (`/v1/sources/:slug/activity`,
    // `/v1/releases/latest`, `/v1/releases/:id`).
    releasesBySourceId: new DataLoader<string, Release[]>(async (sourceIds) => {
      const rows = await chunkedFetch(sourceIds, async (chunk) => {
        const ranked = db
          .select({
            id: releasesVisible.id,
            sourceId: releasesVisible.sourceId,
            version: releasesVisible.version,
            versionSort: releasesVisible.versionSort,
            type: releasesVisible.type,
            title: releasesVisible.title,
            content: releasesVisible.content,
            summary: releasesVisible.summary,
            titleGenerated: releasesVisible.titleGenerated,
            titleShort: releasesVisible.titleShort,
            breaking: releasesVisible.breaking,
            migrationNotes: releasesVisible.migrationNotes,
            url: releasesVisible.url,
            contentHash: releasesVisible.contentHash,
            contentChars: releasesVisible.contentChars,
            contentTokens: releasesVisible.contentTokens,
            metadata: releasesVisible.metadata,
            media: releasesVisible.media,
            publishedAt: releasesVisible.publishedAt,
            prerelease: releasesVisible.prerelease,
            suppressed: releasesVisible.suppressed,
            suppressedReason: releasesVisible.suppressedReason,
            fetchedAt: releasesVisible.fetchedAt,
            embeddedAt: releasesVisible.embeddedAt,
            rn: sql<number>`row_number() OVER (PARTITION BY ${releasesVisible.sourceId} ORDER BY ${releasesVisible.publishedAt} DESC, ${releasesVisible.id} DESC)`.as(
              "rn",
            ),
          })
          .from(releasesVisible)
          .where(inArray(releasesVisible.sourceId, chunk))
          .as("ranked");
        return db.select().from(ranked).where(lte(ranked.rn, RECENT_RELEASE_CAP));
      });
      const grouped = new Map<string, Release[]>();
      for (const row of rows) {
        const list = grouped.get(row.sourceId) ?? [];
        list.push(row);
        grouped.set(row.sourceId, list);
      }
      // ROW_NUMBER ordered by published_at DESC, id DESC; the outer SELECT
      // doesn't preserve row order, so re-sort each group before handing back.
      for (const list of grouped.values()) {
        list.sort((a, b) => {
          const ap = a.publishedAt ?? "";
          const bp = b.publishedAt ?? "";
          if (ap !== bp) return ap < bp ? 1 : -1;
          return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
        });
      }
      return sourceIds.map((id) => grouped.get(id) ?? []);
    }),

    releaseById: new DataLoader<string, Release | null>(async (ids) => {
      const rows = await chunkedFetch(ids, (chunk) =>
        db.select().from(releasesVisible).where(inArray(releasesVisible.id, chunk)),
      );
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      return ids.map((id) => byId.get(id) ?? null);
    }),

    orgTagsByOrgId: new DataLoader<string, string[]>(async (orgIds) => {
      const rows = await chunkedFetch(orgIds, (chunk) =>
        db
          .select({ orgId: orgTags.orgId, name: tags.name })
          .from(orgTags)
          .innerJoin(tags, eq(orgTags.tagId, tags.id))
          .where(inArray(orgTags.orgId, chunk))
          .orderBy(tags.name),
      );
      const grouped = new Map<string, string[]>();
      for (const row of rows) {
        const list = grouped.get(row.orgId) ?? [];
        list.push(row.name);
        grouped.set(row.orgId, list);
      }
      return orgIds.map((id) => grouped.get(id) ?? []);
    }),

    orgAliasesByOrgId: new DataLoader<string, string[]>(async (orgIds) => {
      const rows = await chunkedFetch(orgIds, (chunk) =>
        db
          .select({ orgId: domainAliases.orgId, domain: domainAliases.domain })
          .from(domainAliases)
          .where(inArray(domainAliases.orgId, chunk))
          .orderBy(domainAliases.domain),
      );
      const grouped = new Map<string, string[]>();
      for (const row of rows) {
        if (!row.orgId) continue;
        const list = grouped.get(row.orgId) ?? [];
        list.push(row.domain);
        grouped.set(row.orgId, list);
      }
      return orgIds.map((id) => grouped.get(id) ?? []);
    }),

    orgAccountsByOrgId: new DataLoader<string, { platform: string; handle: string }[]>(
      async (orgIds) => {
        const rows = await chunkedFetch(orgIds, (chunk) =>
          db
            .select({
              orgId: orgAccounts.orgId,
              platform: orgAccounts.platform,
              handle: orgAccounts.handle,
            })
            .from(orgAccounts)
            .where(inArray(orgAccounts.orgId, chunk)),
        );
        const grouped = new Map<string, { platform: string; handle: string }[]>();
        for (const row of rows) {
          const list = grouped.get(row.orgId) ?? [];
          list.push({ platform: row.platform, handle: row.handle });
          grouped.set(row.orgId, list);
        }
        return orgIds.map((id) => grouped.get(id) ?? []);
      },
    ),

    // Mirrors the metrics block of REST `GET /v1/orgs/:slug` (total release
    // count, 30-day + 90-day windows for the avg/week figure, latest
    // fetch/poll timestamps across sources, oldest published_at as
    // trackingSince). One grouped query per stat family, batched by org id.
    orgStatsByOrgId: new DataLoader<string, OrgStats>(async (orgIds) => {
      const cutoff30d = daysAgoIso(30);
      const cutoff90d = daysAgoIso(90);
      const [totals, fetchPoll, orgRows] = await Promise.all([
        chunkedFetch(orgIds, (chunk) =>
          db
            .select({
              orgId: sources.orgId,
              releaseCount: sql<number>`COUNT(${releases.id})`,
              recent30d: sql<number>`COUNT(CASE WHEN ${releases.publishedAt} >= ${cutoff30d} THEN 1 END)`,
              recent90d: sql<number>`COUNT(CASE WHEN ${releases.publishedAt} >= ${cutoff90d} THEN 1 END)`,
              oldest: min(releases.publishedAt),
            })
            .from(releases)
            .innerJoin(sources, eq(releases.sourceId, sources.id))
            .where(inArray(sources.orgId, chunk))
            .groupBy(sources.orgId),
        ),
        chunkedFetch(orgIds, (chunk) =>
          db
            .select({
              orgId: sources.orgId,
              lastFetchedAt: max(sources.lastFetchedAt),
              lastPolledAt: max(sources.lastPolledAt),
            })
            .from(sources)
            .where(inArray(sources.orgId, chunk))
            .groupBy(sources.orgId),
        ),
        chunkedFetch(orgIds, (chunk) =>
          db
            .select({ id: organizations.id, createdAt: organizations.createdAt })
            .from(organizations)
            .where(inArray(organizations.id, chunk)),
        ),
      ]);
      const totalsById = new Map(totals.map((r) => [r.orgId, r] as const));
      const fetchPollById = new Map(fetchPoll.map((r) => [r.orgId, r] as const));
      const createdAtById = new Map(orgRows.map((r) => [r.id, r.createdAt] as const));
      return orgIds.map((id) => {
        const t = totalsById.get(id);
        const fp = fetchPollById.get(id);
        const oldest = t?.oldest ?? null;
        return {
          releaseCount: Number(t?.releaseCount ?? 0),
          releasesLast30Days: Number(t?.recent30d ?? 0),
          avgReleasesPerWeek: computeAvgPerWeek(Number(t?.recent90d ?? 0), oldest),
          lastFetchedAt: fp?.lastFetchedAt ?? null,
          lastPolledAt: fp?.lastPolledAt ?? null,
          trackingSince: oldest ?? createdAtById.get(id) ?? new Date().toISOString(),
        };
      });
    }),

    // Batches the source/release counts + top products behind Org's list-stats
    // fields — one query per (chunked) page of orgs, whether resolving a
    // single `org(idOrSlug)` or a full `orgs` list.
    orgListStatsByOrgId: new DataLoader<string, OrgListStats>(async (ids) => {
      const cutoff30d = daysAgoIso(30);
      const rows = await chunkedFetch(ids, (chunk) => getOrgStatsByIds(db, cutoff30d, chunk));
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      return ids.map((id) => {
        const r = byId.get(id);
        return {
          sourceCount: Number(r?.source_count ?? 0),
          releaseCount: Number(r?.release_count ?? 0),
          recentReleaseCount: Number(r?.recent_release_count ?? 0),
          lastActivity: r?.last_activity ?? null,
          topProducts: r?.top_products ? r.top_products.split("||") : [],
        };
      });
    }),

    // Mirrors `getOrgSourcesWithStats` (workers/api/src/queries/orgs.ts),
    // batched by source id instead of scoped to a single org so it composes
    // with the existing sourcesByOrgId / sourcesByProductId loaders.
    sourceStatsBySourceId: new DataLoader<string, SourceStats>(async (sourceIds) => {
      const rows = await chunkedFetch(sourceIds, (chunk) =>
        db
          .select({
            sourceId: releasesVisible.sourceId,
            releaseCount: sql<number>`COUNT(*)`,
            latestDate: sql<
              string | null
            >`MAX(CASE WHEN ${releasesVisible.publishedAt} IS NOT NULL THEN ${releasesVisible.publishedAt} END)`,
            latestAddedAt: sql<string | null>`MAX(${releasesVisible.fetchedAt})`,
            packByDate: sql<
              string | null
            >`MAX(CASE WHEN ${releasesVisible.publishedAt} IS NOT NULL THEN ${releasesVisible.publishedAt} || '|' || COALESCE(${releasesVisible.version}, '') END)`,
          })
          .from(releasesVisible)
          .where(inArray(releasesVisible.sourceId, chunk))
          .groupBy(releasesVisible.sourceId),
      );
      const bySourceId = new Map(rows.map((r) => [r.sourceId, r] as const));
      return sourceIds.map((id) => {
        const r = bySourceId.get(id);
        if (!r)
          return { releaseCount: 0, latestVersion: null, latestDate: null, latestAddedAt: null };
        const pack = r.packByDate;
        const latestVersion = pack ? pack.slice(pack.indexOf("|") + 1) || null : null;
        return {
          releaseCount: Number(r.releaseCount),
          latestVersion,
          latestDate: r.latestDate ?? null,
          latestAddedAt: r.latestAddedAt ?? null,
        };
      });
    }),

    // Mirrors the product-list subselects in REST `GET /v1/orgs/:slug`
    // (products_active.sourceCount / releaseCount), batched by product id.
    productStatsByProductId: new DataLoader<string, { sourceCount: number; releaseCount: number }>(
      async (productIds) => {
        const rows = await chunkedFetch(productIds, (chunk) =>
          db
            .select({
              productId: sourcesVisible.productId,
              sourceCount: sql<number>`COUNT(DISTINCT ${sourcesVisible.id})`,
              releaseCount: sql<number>`COUNT(${releasesVisible.id})`,
            })
            .from(sourcesVisible)
            .leftJoin(releasesVisible, eq(releasesVisible.sourceId, sourcesVisible.id))
            .where(inArray(sourcesVisible.productId, chunk))
            .groupBy(sourcesVisible.productId),
        );
        const byProductId = new Map(
          rows.filter((r) => r.productId !== null).map((r) => [r.productId as string, r] as const),
        );
        return productIds.map((id) => byProductId.get(id) ?? { sourceCount: 0, releaseCount: 0 });
      },
    ),

    // 30-day per-day release counts, aligned into a fixed 30-length array —
    // mirrors the REST `/v1/orgs` sparkline shaping. `getOrgSparklines`
    // already chunks internally past 90 ids.
    orgSparklineByOrgId: new DataLoader<string, number[]>(async (ids) => {
      const cutoff30d = daysAgoIso(30);
      const rows = await getOrgSparklines(db, cutoff30d, ids as string[]);
      const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
      const map = new Map<string, number[]>();
      for (const row of rows) {
        if (!map.has(row.org_id)) {
          map.set(
            row.org_id,
            Array.from({ length: 30 }, () => 0),
          );
        }
        const dayDate = new Date(row.date + "T00:00:00Z");
        const daysAgo = Math.floor((today.getTime() - dayDate.getTime()) / (1000 * 60 * 60 * 24));
        const idx = 29 - daysAgo;
        if (idx >= 0 && idx < 30) map.get(row.org_id)![idx] = row.cnt;
      }
      return ids.map((id) => map.get(id) ?? Array.from({ length: 30 }, () => 0));
    }),
  };
}

/** Org list-page aggregate — mirrors the REST `/v1/orgs` catalog stats
 *  (`getOrgStatsByIds` in workers/api/src/queries/orgs.ts), batched by org id. */
export type OrgListStats = {
  sourceCount: number;
  releaseCount: number;
  recentReleaseCount: number;
  lastActivity: string | null;
  topProducts: string[];
};

export type { Org, Product, Source, Release };
