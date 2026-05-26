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

  let appStore: { platform?: string; artworkUrl?: string } | undefined;
  try {
    const parsed = JSON.parse(source.metadata ?? "{}") as {
      appStore?: { platform?: string; artworkUrl?: string };
    };
    appStore = parsed?.appStore;
  } catch {
    appStore = undefined;
  }

  const platform = appStore?.platform === "macos" ? "macos" : "ios";
  return {
    platform,
    label: platform === "macos" ? "macOS" : "iOS",
    iconUrl: appStore?.artworkUrl ?? null,
  };
}
