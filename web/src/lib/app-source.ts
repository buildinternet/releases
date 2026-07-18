import { IMPORTANCE_HIGH } from "@buildinternet/releases-core/importance";

/**
 * Cross-promo gate for the client-side discovery surface (the homepage ticker),
 * mirroring the server's related-rail filter (`isRoutineAppRelease`): a
 * mobile-app release earns a slot on a cross-promotional surface only when the
 * AI flagged it notable (`importance >= IMPORTANCE_HIGH`); an unscored (`null`)
 * app release folds below the floor. Non-app releases always pass. `isApp` is
 * whether the release's source is an App Store source. Returns true when the
 * release should be SHOWN. #mobile-app-release-cards
 */
export function keepInCrossPromo(isApp: boolean, importance: number | null | undefined): boolean {
  if (!isApp) return true;
  return (importance ?? 0) >= IMPORTANCE_HIGH;
}

/**
 * Display info for a mobile/desktop App Store source. App Store sources
 * (`type === "appstore"`) carry the app icon + platform in
 * `metadata.appStore`; this reads it back for the UI. Returns `null` for any
 * non-app source, so callers gate app-only treatment with
 * `if (getAppInfo(source))`. Tolerant of null/missing/malformed metadata — an
 * app source with unparseable metadata still yields a badge (just no icon).
 */
export interface AppInfo {
  platform: "ios" | "macos";
  label: "iOS" | "macOS";
  iconUrl: string | null;
}

/**
 * Display payload for the compact App Store feed row. `appName` is the source
 * name; `label` is the human platform; `iconUrl` is the (un-resized) mzstatic
 * artwork URL or null. Consumed by `ReleaseListItem`'s appstore branch.
 */
export interface AppRowInfo {
  label: "iOS" | "macOS";
  iconUrl: string | null;
  appName: string;
}

/**
 * Build an {@link AppRowInfo} from the wire-shape `appStore` block
 * (`{ platform, iconUrl }`, already resolved server-side by `appStoreSourceInfo`)
 * plus the source/app name. Returns null when the block is absent so callers
 * gate app-only treatment with `appRowInfoFromWire(...)`. Used by the org feed,
 * rollup header, and search card — all of which receive the resolved block
 * rather than raw metadata, so `getAppInfo` (which parses metadata) doesn't fit.
 */
export function appRowInfoFromWire(
  appStore: { platform: "ios" | "macos"; iconUrl: string | null } | null | undefined,
  appName: string,
): AppRowInfo | null {
  if (!appStore) return null;
  return {
    label: appStore.platform === "macos" ? "macOS" : "iOS",
    iconUrl: appStore.iconUrl,
    appName,
  };
}

interface AppSourceLike {
  type: string;
  metadata?: string | null;
}

export function getAppInfo(source: AppSourceLike): AppInfo | null {
  if (source.type !== "appstore") return null;

  // Parse defensively: the metadata blob is untrusted JSON, so validate that
  // appStore is an object and that the fields we read are actually strings
  // before they flow into the typed AppInfo (a non-string artworkUrl would
  // otherwise leak through `?? null` and break the `string | null` contract).
  let appStore: Record<string, unknown> | undefined;
  try {
    const block = (JSON.parse(source.metadata ?? "{}") as { appStore?: unknown } | null)?.appStore;
    if (block && typeof block === "object") appStore = block as Record<string, unknown>;
  } catch {
    appStore = undefined;
  }

  const platform = appStore?.platform === "macos" ? "macos" : "ios";
  const iconUrl = typeof appStore?.artworkUrl === "string" ? appStore.artworkUrl : null;
  return {
    platform,
    label: platform === "macos" ? "macOS" : "iOS",
    iconUrl,
  };
}

/**
 * Resize an App Store (mzstatic) artwork URL by rewriting its
 * `/{w}x{h}bb.{ext}` dimension suffix to a square `px`. The stored icon is a
 * 1024px PNG; feed/detail render it small, so we request a smaller asset
 * instead of shipping 1024px into a 36px box. Returns the input unchanged when
 * it doesn't match the known pattern. Mirrors `upscaleArtwork` in
 * packages/adapters/src/appstore.ts.
 */
export function appStoreIconUrl(url: string, px: number): string {
  return url.replace(/\/\d+x\d+bb\.(jpg|png|webp)$/i, `/${px}x${px}bb.$1`);
}
