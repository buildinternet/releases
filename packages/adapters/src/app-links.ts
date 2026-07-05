/**
 * Pure parsers for the two platform "app links" well-known files a domain
 * publishes to associate its native apps with the site:
 *
 * - Apple **App Site Association** (AASA) — `/.well-known/apple-app-site-association`,
 *   declares iOS/macOS `appID`s in `TEAMID.bundle.id` form (Universal Links).
 * - Android **Digital Asset Links** — `/.well-known/assetlinks.json`, declares
 *   Android `package_name`s linked to the domain (App Links verification).
 *
 * These files are published intentionally for machine consumption, so probing
 * them carries no crawl-consent ambiguity. Both are JSON; the functions here
 * take the already-parsed value and are defensive against any shape — an
 * unexpected structure yields an empty result, never a throw. The fetch itself
 * (SSRF screen, size/time caps) lives in the caller.
 */

/** A 10-char Apple Team ID prefix, e.g. `9JA89QQLNQ`. */
const TEAM_ID_RE = /^[A-Z0-9]{10}$/i;

/**
 * Split an AASA `appID` (`TEAMID.bundle.id`) into its bundle identifier,
 * dropping the 10-char Team ID prefix. Returns null when the input isn't in the
 * expected `TEAMID.<bundle with at least one dot>` shape — fail closed rather
 * than pass a malformed identifier downstream to the iTunes lookup.
 */
export function bundleIdFromAppId(appId: string): string | null {
  const trimmed = appId.trim();
  const dot = trimmed.indexOf(".");
  if (dot === -1) return null;
  const team = trimmed.slice(0, dot);
  const bundle = trimmed.slice(dot + 1);
  if (!TEAM_ID_RE.test(team)) return null;
  // A real bundle id is reverse-DNS, so it always contains a dot.
  if (!bundle.includes(".")) return null;
  return bundle;
}

/** Map an Android package name to its Play Store listing URL. */
export function playStoreUrl(packageName: string): string {
  return `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Collect the raw `appID` strings declared anywhere in an AASA document. */
function collectAppIds(json: unknown): string[] {
  if (!isRecord(json)) return [];
  const ids: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") ids.push(v);
  };

  // applinks.details[].appID | .appIDs[]
  const applinks = json.applinks;
  if (isRecord(applinks) && Array.isArray(applinks.details)) {
    for (const detail of applinks.details) {
      if (!isRecord(detail)) continue;
      push(detail.appID);
      if (Array.isArray(detail.appIDs)) for (const a of detail.appIDs) push(a);
    }
  }

  // webcredentials.apps[] — same TEAMID.bundle form, another ownership signal.
  const webcreds = json.webcredentials;
  if (isRecord(webcreds) && Array.isArray(webcreds.apps)) {
    for (const a of webcreds.apps) push(a);
  }

  return ids;
}

/**
 * Parse a fetched AASA document into the distinct set of iOS/macOS bundle IDs
 * it declares (order-preserving, deduped). Malformed appIDs are dropped.
 */
export function parseAppSiteAssociation(json: unknown): { bundleIds: string[] } {
  const seen = new Set<string>();
  const bundleIds: string[] = [];
  for (const appId of collectAppIds(json)) {
    const bundle = bundleIdFromAppId(appId);
    if (bundle && !seen.has(bundle)) {
      seen.add(bundle);
      bundleIds.push(bundle);
    }
  }
  return { bundleIds };
}

/**
 * Parse a fetched `assetlinks.json` (a top-level array of statements) into the
 * distinct set of Android package names it links to the domain (order-preserving,
 * deduped). Only `android_app` targets are considered.
 */
export function parseAssetLinks(json: unknown): { packageNames: string[] } {
  if (!Array.isArray(json)) return { packageNames: [] };
  const seen = new Set<string>();
  const packageNames: string[] = [];
  for (const statement of json) {
    if (!isRecord(statement)) continue;
    const target = statement.target;
    if (!isRecord(target)) continue;
    if (target.namespace !== "android_app") continue;
    const pkg = target.package_name;
    if (typeof pkg !== "string" || !pkg.trim()) continue;
    const name = pkg.trim();
    if (!seen.has(name)) {
      seen.add(name);
      packageNames.push(name);
    }
  }
  return { packageNames };
}
