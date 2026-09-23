/**
 * Declared release locations (#1947): the locator rows a stub org publishes
 * in its `releases.json`. Both workers read them for the stub read surface —
 * the API as wire items, MCP as formatted lines — so the filter and the
 * order live here.
 *
 * Order is canonical first, then `match_key`, so responses (and #1871's
 * export) are stable across calls. Soft-deleted rows are excluded.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { releaseLocations } from "@buildinternet/releases-core/schema";
import type { ReleaseLocationItem } from "@buildinternet/releases-api-types";
import type { AnyDb } from "@releases/lib/db";

/** Row shape of the `release_locations` table. */
export type ReleaseLocationRow = typeof releaseLocations.$inferSelect;

/** An org's live locator rows, canonical first, then by `match_key`. */
export async function listReleaseLocationRows(
  db: AnyDb,
  orgId: string,
): Promise<ReleaseLocationRow[]> {
  return db
    .select()
    .from(releaseLocations)
    .where(and(eq(releaseLocations.orgId, orgId), isNull(releaseLocations.deletedAt)))
    .orderBy(desc(releaseLocations.canonical), asc(releaseLocations.matchKey));
}

/** Project a stored locator row onto its wire shape — only set locator keys are
 *  emitted so the discriminator stays clean, mirroring the manifest entry. */
export function mapReleaseLocation(row: ReleaseLocationRow): ReleaseLocationItem {
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

/** An org's declared release locations as wire items. */
export async function loadReleaseLocations(
  db: AnyDb,
  orgId: string,
): Promise<ReleaseLocationItem[]> {
  return (await listReleaseLocationRows(db, orgId)).map(mapReleaseLocation);
}
