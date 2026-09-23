import { and, asc, eq, isNull } from "drizzle-orm";
import { releaseLocations } from "@buildinternet/releases-core/schema";
import type { ReleaseLocationItem } from "@buildinternet/releases-api-types";
import type { createDb } from "../../db.js";

type Db = ReturnType<typeof createDb>;

/** Project a stored locator row onto its wire shape — only set locator keys are
 *  emitted so the discriminator stays clean, mirroring the manifest entry. */
export function mapReleaseLocation(row: typeof releaseLocations.$inferSelect): ReleaseLocationItem {
  return {
    ...(row.url ? { url: row.url } : {}),
    ...(row.feed ? { feed: row.feed } : {}),
    ...(row.github ? { github: row.github } : {}),
    ...(row.appstore ? { appstore: row.appstore } : {}),
    ...(row.file ? { file: row.file } : {}),
    ...(row.title ? { title: row.title } : {}),
    canonical: row.canonical,
    basis: row.basis,
    productId: row.productId,
    sourceId: row.sourceId,
  };
}

/**
 * Load an org's declared release locations as wire items (#1947). Ordered
 * deterministically — canonical first, then by match_key — so read responses
 * (and #1871's export) are stable across calls. Soft-deleted rows are excluded.
 */
export async function loadReleaseLocations(db: Db, orgId: string): Promise<ReleaseLocationItem[]> {
  const rows = await db
    .select()
    .from(releaseLocations)
    .where(and(eq(releaseLocations.orgId, orgId), isNull(releaseLocations.deletedAt)))
    .orderBy(asc(releaseLocations.matchKey));
  // Canonical first (true before false), then the SQL match_key order (JS sort
  // is stable, so equal-canonical rows keep the match_key ordering).
  return [...rows]
    .sort((a, b) => Number(b.canonical) - Number(a.canonical))
    .map(mapReleaseLocation);
}
