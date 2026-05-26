/**
 * Junk-media detection shared by ingest (drop before R2 upload) and the
 * Open Graph hero-image picker. Pure + URL-only: it never fetches. The
 * ingest path pairs this cheap pre-filter with a post-fetch content-type +
 * byte-size gate (the real defense against tracking pixels / spacers, which
 * aren't reliably distinguishable by URL).
 */

/**
 * URL substrings that mark a media item as chrome rather than real content:
 * author-avatar crops baked into changelog pages, gravatar/`?s=NN` thumbnails,
 * and `/avatar/` paths.
 */
export const SMALL_MEDIA_MARKERS: readonly string[] = [
  "c_fill,w_44",
  "c_fill,w_48",
  "c_fill,w_64",
  "c_fill,w_96",
  "/avatar/",
  "?s=32",
  "?s=44",
  "?s=48",
  "?s=64",
  "&s=32",
  "&s=44",
  "&s=48",
  "&s=64",
];

/** Returns true when a URL points at junk we never want to mirror or promote. */
export function isJunkMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (url.startsWith("data:")) return true;
  if (/(?:^|\/)favicon[.-]/i.test(url)) return true;
  return SMALL_MEDIA_MARKERS.some((marker) => url.includes(marker));
}

/** Drop junk items (favicons, avatars, data URIs) from a media list. */
export function filterJunkMedia<T extends { url: string }>(media: readonly T[]): T[] {
  return media.filter((m) => !isJunkMediaUrl(m.url));
}
