import type { Source } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "./types.js";
import { RELEASES_BOT_UA } from "./user-agent.js";

/** A single result from the iTunes Lookup API. Only fields we consume are typed. */
export interface AppStoreListing {
  trackId: number;
  bundleId: string;
  trackName: string;
  version: string;
  currentVersionReleaseDate?: string;
  releaseDate?: string;
  releaseNotes?: string;
  trackViewUrl: string;
  artistName?: string;
  sellerName?: string;
  primaryGenreName?: string;
  artworkUrl512?: string;
  artworkUrl100?: string;
  screenshotUrls?: string[];
  ipadScreenshotUrls?: string[];
  minimumOsVersion?: string;
}

/** Resolved fetch coordinate for one platform's listing. */
export interface AppStoreCoordinate {
  trackId: string;
  platform: "ios" | "macos";
  storefront: string;
}

const TRACK_ID_RE = /^\d+$/;
const URL_ID_RE = /\/id(\d+)/;

/**
 * Parse a store identifier — a bare numeric trackId or an
 * `apps.apple.com/.../id<trackId>` URL — into a fetch coordinate. Returns null
 * when the input is neither. `platform`/`storefront` default to ios/us and are
 * overridable via opts.
 */
export function parseAppStoreIdentifier(
  input: string,
  opts?: { platform?: "ios" | "macos"; storefront?: string },
): AppStoreCoordinate | null {
  const platform = opts?.platform ?? "ios";
  const storefront = opts?.storefront ?? "us";
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (TRACK_ID_RE.test(trimmed)) return { trackId: trimmed, platform, storefront };
  const m = trimmed.match(URL_ID_RE);
  if (m) {
    // Validate the host instead of a substring check, so a stray
    // "apps.apple.com" anywhere in the string can't smuggle in a trackId.
    // Tolerate a scheme-less paste by prepending https:// before parsing.
    try {
      const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
      if (parsed.hostname === "apps.apple.com" || parsed.hostname.endsWith(".apps.apple.com")) {
        return { trackId: m[1]!, platform, storefront };
      }
    } catch {
      // not a parseable URL — fall through to null
    }
  }
  return null;
}

/** Drop the `?uo=` (and any other) query string from a trackViewUrl. */
export function stripUoParam(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}

/**
 * Swap the mzstatic dimension suffix (`/{w}x{h}bb.{ext}`) for a 1024px PNG.
 * Returns the input unchanged if it doesn't match the known pattern.
 */
export function upscaleArtwork(url: string): string {
  return url.replace(/\/\d+x\d+bb\.(?:jpg|png|webp)$/i, "/1024x1024bb.png");
}

/** Append the version as a `?v=` param so each version is a distinct release URL. */
export function versionDistinctUrl(cleanUrl: string, version: string): string {
  return `${cleanUrl}?v=${encodeURIComponent(version)}`;
}

/** Map a listing into the single RawRelease for its current version. */
export function mapListingToRawReleases(
  listing: AppStoreListing,
  // Reserved for future platform-specific URL overrides (e.g. macOS app-store
  // host or storefront-localized canonical links); unused today.
  _coord: AppStoreCoordinate,
): RawRelease[] {
  const cleanUrl = stripUoParam(listing.trackViewUrl);
  const screenshots = [...(listing.screenshotUrls ?? []), ...(listing.ipadScreenshotUrls ?? [])];
  const media = screenshots.map((url) => ({ type: "image" as const, url }));
  // Guard against a malformed date string producing an Invalid Date, which
  // would throw downstream on .toISOString().
  const published = listing.currentVersionReleaseDate
    ? new Date(listing.currentVersionReleaseDate)
    : undefined;
  return [
    {
      version: listing.version,
      title: `${listing.trackName} ${listing.version}`,
      content: listing.releaseNotes ?? "",
      url: versionDistinctUrl(cleanUrl, listing.version),
      publishedAt: published && !Number.isNaN(published.getTime()) ? published : undefined,
      media,
    },
  ];
}

/** Read the appStore coordinate out of a source's metadata. Null if absent. */
export function appStoreCoordFromSource(source: Source): AppStoreCoordinate | null {
  let meta: { appStore?: Partial<AppStoreCoordinate> };
  try {
    meta = JSON.parse(source.metadata ?? "{}");
  } catch {
    return null;
  }
  const a = meta.appStore;
  if (!a?.trackId) return null;
  return {
    trackId: a.trackId,
    platform: a.platform === "macos" ? "macos" : "ios",
    storefront: a.storefront ?? "us",
  };
}

/**
 * Call the iTunes Lookup API for one coordinate. Returns the single listing, or
 * null on non-2xx OR any network/parse error (DNS, timeout, malformed JSON,
 * not-found, empty). Never throws — the caller treats null as a no-op poll, so
 * a transient blip doesn't bump the source's consecutiveErrors counter.
 */
export async function resolveAppStore(coord: AppStoreCoordinate): Promise<AppStoreListing | null> {
  const entity = coord.platform === "macos" ? "&entity=macSoftware" : "";
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(coord.trackId)}&country=${encodeURIComponent(coord.storefront)}${entity}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": RELEASES_BOT_UA } });
    if (!res.ok) return null;
    const data = (await res.json()) as { resultCount?: number; results?: AppStoreListing[] };
    if (!data.resultCount || !data.results?.length) return null;
    return data.results[0]!;
  } catch {
    return null;
  }
}

/** Convenience: resolve straight from a source row. */
export async function fetchAppStore(source: Source): Promise<RawRelease[]> {
  const coord = appStoreCoordFromSource(source);
  if (!coord) return [];
  const listing = await resolveAppStore(coord);
  if (!listing) return [];
  return mapListingToRawReleases(listing, coord);
}

/**
 * Parse the read-surface app info (platform + icon) from a source row's `type`
 * + raw `metadata` JSON. Returns null for non-appstore sources. Defensive
 * against null/missing/malformed metadata — an appstore source with
 * unparseable metadata still yields `{ platform: "ios", iconUrl: null }` so the
 * UI degrades to a generic app row. Mirrors the web-side `getAppInfo`
 * (web/src/lib/app-source.ts) and feeds the wire `AppStoreSourceInfoSchema`.
 */
export function appStoreSourceInfo(
  type: string,
  metadataJson: string | null,
): { platform: "ios" | "macos"; iconUrl: string | null } | null {
  if (type !== "appstore") return null;
  let appStore: Record<string, unknown> | undefined;
  try {
    const block = (JSON.parse(metadataJson ?? "{}") as { appStore?: unknown } | null)?.appStore;
    if (block && typeof block === "object") appStore = block as Record<string, unknown>;
  } catch {
    appStore = undefined;
  }
  const platform = appStore?.platform === "macos" ? "macos" : "ios";
  const iconUrl = typeof appStore?.artworkUrl === "string" ? appStore.artworkUrl : null;
  return { platform, iconUrl };
}
