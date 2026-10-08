/**
 * Resolve a `releases admin org avatar --from <value>` shortcut to a concrete
 * image URL. Resolution runs client-side so CF credentials stay server-side — the
 * server does the fetch + square-raster validation + R2 mirror (#1406).
 */

/** GitHub's per-account avatar redirect — `github.com/{handle}.png`. */
export function githubAvatarUrl(handle: string): string {
  return `https://github.com/${encodeURIComponent(handle.replace(/^@/, ""))}.png`;
}

/**
 * Convention apple-touch-icon for a domain. The endpoint validates it's a square
 * raster, so a missing/odd icon is rejected with a clear error rather than stored.
 */
export function faviconAvatarUrl(domain: string): string {
  const host = domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
  return `https://${host}/apple-touch-icon.png`;
}

/** Numeric App Store track id from an apps.apple.com URL (`…/id123456`), else null. */
export function appStoreTrackId(url: string): string | null {
  const m = /\/id(\d+)/.exec(url);
  return m ? m[1]! : null;
}

/** Upscale an iTunes artwork URL's `NxN` size segment to 1024×1024 (best-effort). */
export function upscaleArtwork(url: string): string {
  return url.replace(/\/\d+x\d+(bb)?\.(png|jpe?g|webp)(\?.*)?$/i, "/1024x1024$1.$2$3");
}

/** Look up an App Store app's largest artwork via the iTunes lookup API. */
export async function appStoreArtworkUrl(
  trackId: string,
  fetchImpl: (input: string) => Promise<Response> = fetch,
): Promise<string | null> {
  const res = await fetchImpl(`https://itunes.apple.com/lookup?id=${encodeURIComponent(trackId)}`);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results?: Array<{ artworkUrl512?: string; artworkUrl100?: string }>;
  };
  const art = data.results?.[0]?.artworkUrl512 ?? data.results?.[0]?.artworkUrl100;
  return art ? upscaleArtwork(art) : null;
}
