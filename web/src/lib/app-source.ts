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
