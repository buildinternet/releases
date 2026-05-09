import DataLoader from "dataloader";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  organizations,
  products,
  releasesVisible,
  sources,
} from "@buildinternet/releases-core/schema";
import type { D1Db } from "../db.js";
import { RELEASES_ID_IN_CHUNK_SIZE } from "../lib/d1-limits.js";

type Org = typeof organizations.$inferSelect;
type Product = typeof products.$inferSelect;
type Source = typeof sources.$inferSelect;
type Release = typeof releasesVisible.$inferSelect;

export type Loaders = ReturnType<typeof createLoaders>;

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
            type: releasesVisible.type,
            title: releasesVisible.title,
            content: releasesVisible.content,
            contentSummary: releasesVisible.contentSummary,
            contentTitle: releasesVisible.contentTitle,
            contentTitleShort: releasesVisible.contentTitleShort,
            url: releasesVisible.url,
            contentHash: releasesVisible.contentHash,
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
  };
}

export type { Org, Product, Source, Release };
