import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  organizations,
  organizationsActive,
  products,
  productsActive,
  sources,
  sourcesActive,
  releases,
} from "@buildinternet/releases-core/schema";
import {
  upscaleArtwork,
  type AppStoreListing,
  type AppStoreCoordinate,
  parseAppStoreIdentifier,
  resolveAppStore,
  mapListingToRawReleases,
  stripUoParam,
} from "@releases/adapters/appstore";
import type { Source } from "@buildinternet/releases-core/schema";
import { newOrgId, newProductId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { toSlug } from "@buildinternet/releases-core/slug";
import { computeVersionSort } from "@buildinternet/releases-core/version-sort";
import { computeContentSize } from "@buildinternet/releases-core/tokens";
import { RELEASE_URL_UPSERT } from "@releases/core-internal/release-upsert";
import type { createDb } from "../db.js";

type Db = ReturnType<typeof drizzle>;

/** Build the `appStore` metadata sub-object from a listing + coordinate. */
function buildAppStoreBlock(listing: AppStoreListing, coord: AppStoreCoordinate) {
  return {
    trackId: coord.trackId,
    bundleId: listing.bundleId,
    storefront: coord.storefront,
    platform: coord.platform,
    firstPublishedAt: listing.releaseDate,
    minOsVersion: listing.minimumOsVersion,
    artworkUrl: listing.artworkUrl512 ? upscaleArtwork(listing.artworkUrl512) : undefined,
  };
}

/**
 * Build the source-row `metadata` JSON for a brand-new App Store source: just
 * the `{appStore:...}` block. Task 8's create path uses this — a full
 * overwrite is correct for a row with no prior metadata.
 */
export function buildAppStoreMeta(listing: AppStoreListing, coord: AppStoreCoordinate): string {
  return JSON.stringify({ appStore: buildAppStoreBlock(listing, coord) });
}

/**
 * Best-effort refresh of mutable listing fields on poll: source name + the
 * appStore metadata block, and the parent product's avatar when present.
 * Never throws — a failed refresh must not fail the fetch.
 *
 * Merges rather than overwrites: any other metadata keys on the row are
 * preserved and only the `appStore` sub-object is replaced.
 */
export async function refreshAppStoreListing(
  db: Db,
  source: Source,
  listing: AppStoreListing,
): Promise<void> {
  try {
    let existing: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(source.metadata ?? "{}");
      if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
    } catch {
      // malformed metadata — treat as empty so the refresh still re-bases it
    }
    const prior = existing.appStore as
      | { platform?: "ios" | "macos"; storefront?: string }
      | undefined;
    const coord: AppStoreCoordinate = {
      trackId: String(listing.trackId),
      platform: prior?.platform === "macos" ? "macos" : "ios",
      storefront: prior?.storefront ?? "us",
    };
    const merged = JSON.stringify({ ...existing, appStore: buildAppStoreBlock(listing, coord) });
    await db
      .update(sources)
      .set({ name: listing.trackName, metadata: merged })
      .where(eq(sources.id, source.id));
    if (source.productId && listing.artworkUrl512) {
      await db
        .update(products)
        .set({ avatarUrl: upscaleArtwork(listing.artworkUrl512) })
        .where(eq(products.id, source.productId));
    }
  } catch {
    // best-effort
  }
}

export interface MaterializeAppStoreParams {
  identifier: string;
  platform?: "ios" | "macos";
  storefront?: string;
  orgSlug?: string;
  productSlug?: string;
}

export type MaterializeResult =
  | { status: "bad_request" }
  | { status: "not_found" }
  | {
      status: "indexed" | "existing";
      source: typeof sources.$inferSelect;
      releaseCount: number;
    };

/**
 * Resolve a store identifier and materialize a curated Org → Product → Source
 * → first Release. Idempotent on the source's metadata.appStore.trackId.
 * Modeled on runLookup (routes/lookups.ts) but curated/visible, not hidden.
 */
export async function materializeAppStoreSource(
  db: ReturnType<typeof createDb>,
  params: MaterializeAppStoreParams,
): Promise<MaterializeResult> {
  const coord = parseAppStoreIdentifier(params.identifier, {
    platform: params.platform,
    storefront: params.storefront,
  });
  if (!coord) return { status: "bad_request" };

  const listing = await resolveAppStore(coord);
  if (!listing) return { status: "not_found" };

  const cleanUrl = stripUoParam(listing.trackViewUrl);

  // Idempotency: an existing appstore source for this trackId wins.
  const existing = await db
    .select()
    .from(sourcesActive)
    .where(
      and(
        eq(sourcesActive.type, "appstore"),
        sql`json_extract(${sourcesActive.metadata}, '$.appStore.trackId') = ${coord.trackId}`,
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    const src = existing[0]! as typeof sources.$inferSelect;
    const rel = await db.select().from(releases).where(eq(releases.sourceId, src.id));
    return { status: "existing", source: src, releaseCount: rel.length };
  }

  // Org (curated). Prefer caller-supplied slug, else derive from seller name.
  const developerName = listing.sellerName ?? listing.artistName ?? listing.trackName;
  const orgSlug = (params.orgSlug ?? toSlug(developerName)).toLowerCase();
  const orgId = newOrgId();
  await db
    .insert(organizations)
    .values({ id: orgId, name: developerName, slug: orgSlug, discovery: "curated" })
    .onConflictDoNothing();
  const [org] = await db
    .select()
    .from(organizationsActive)
    .where(eq(organizationsActive.slug, orgSlug))
    .limit(1);
  const resolvedOrgId = org!.id;

  // Product (curated, always). Prefer caller-supplied slug, else app name.
  const kind = coord.platform === "macos" ? "desktop" : "mobile";
  const icon = listing.artworkUrl512 ? upscaleArtwork(listing.artworkUrl512) : null;
  const productSlug = (params.productSlug ?? toSlug(listing.trackName)).toLowerCase();
  const [existingProduct] = await db
    .select()
    .from(productsActive)
    .where(and(eq(productsActive.orgId, resolvedOrgId), eq(productsActive.slug, productSlug)))
    .limit(1);
  let productId: string;
  if (existingProduct) {
    productId = existingProduct.id;
    if (!existingProduct.avatarUrl && icon) {
      await db.update(products).set({ avatarUrl: icon }).where(eq(products.id, productId));
    }
  } else {
    productId = newProductId();
    await db.insert(products).values({
      id: productId,
      name: listing.trackName,
      slug: productSlug,
      orgId: resolvedOrgId,
      kind,
      avatarUrl: icon,
    });
  }

  // Source (curated, visible). Slug is `<product>-<platform>`.
  const sourceId = newSourceId();
  const sourceSlug = `${productSlug}-${coord.platform === "macos" ? "macos" : "ios"}`;
  // NOTE: concurrent POSTs for the same new trackId both clear the idempotency
  // check above, then race on UNIQUE(org_id, slug) for the product/source inserts.
  // This endpoint is admin-gated + low-concurrency, so a rare 500 on a true race is
  // acceptable; if it ever matters, wrap in isConflictError + re-read like runLookup.
  const [insertedSource] = await db
    .insert(sources)
    .values({
      id: sourceId,
      name: listing.trackName,
      slug: sourceSlug,
      type: "appstore",
      url: cleanUrl,
      orgId: resolvedOrgId,
      productId,
      kind,
      discovery: "curated",
      isHidden: false,
      metadata: buildAppStoreMeta(listing, coord),
    })
    .returning();

  // First release.
  const raw = mapListingToRawReleases(listing, coord);
  const rows = raw.map((r) => {
    const size = computeContentSize(r.content);
    return {
      id: newReleaseId(),
      sourceId,
      version: r.version ?? null,
      versionSort: computeVersionSort(r.version),
      title: r.title,
      content: r.content,
      url: r.url ?? null,
      contentChars: size.contentChars,
      contentTokens: size.contentTokens,
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      media: JSON.stringify(r.media ?? []),
    };
  });
  await db.insert(releases).values(rows).onConflictDoUpdate(RELEASE_URL_UPSERT);

  return { status: "indexed", source: insertedSource!, releaseCount: rows.length };
}
