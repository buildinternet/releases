import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { products, sources } from "@buildinternet/releases-core/schema";
import {
  upscaleArtwork,
  type AppStoreListing,
  type AppStoreCoordinate,
} from "@releases/adapters/appstore";
import type { Source } from "@buildinternet/releases-core/schema";

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
