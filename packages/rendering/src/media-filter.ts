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
 *
 * Prefer {@link hasTinyForcedDimensions} for Cloudinary/imgix-style transforms —
 * these markers are the historical allowlist-shaped catches that still matter for
 * hosts that only stamp `/avatar/` or Gravatar `?s=`.
 */
export const SMALL_MEDIA_MARKERS: readonly string[] = [
  "c_fill,w_32",
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

/**
 * URL substrings that mark decorative chrome baked into changelog bodies —
 * emoji sprites and CI-review badges — that get scraped into `media[]` but are
 * never real release content. Kept separate from {@link SMALL_MEDIA_MARKERS}
 * (author-avatar crops) only for readability; both feed {@link isJunkMediaUrl}.
 *
 * Each entry is a specific vendor path, not a broad category (deliberately NOT
 * "all SVGs" — a product logo or diagram can be a legitimate SVG), so there are
 * no false positives on real media.
 */
export const CHROME_MEDIA_MARKERS: readonly string[] = [
  "s.w.org/images/core/emoji/", // WordPress emoji sprites rendered as <img>
  "cubic.dev/buttons", // "Review in Cubic" CI badge
  "stagereview.app/assets", // "Open in Stage" CI badge
  "shields.io", // shields.io status badges
];

/**
 * Largest forced edge (px) we still treat as a thumbnail / avatar crop rather
 * than editorial media. Matches the classify-media-relevance skill's "under
 * ~200×200 square is likely chrome" guidance, with room for slightly larger
 * author thumbs that still look garbage when scaled into a feed card.
 */
export const TINY_FORCED_EDGE_PX = 128;

/**
 * Parse width/height stamped into a CDN transform URL (Cloudinary path segments
 * like `w_32,h_32` / `c_fill,w_32,h_32`, or query params `w=`/`h=`/`width=`/
 * `height=`). Returns nulls when a dimension isn't present — we only reject when
 * we can see both edges are tiny, so a lone `w_800` hero crop still passes.
 */
export function parseForcedMediaDimensions(url: string): {
  width: number | null;
  height: number | null;
} {
  let width: number | null = null;
  let height: number | null = null;

  // Cloudinary / similar path transforms: w_32, h_32 (underscore form).
  for (const match of url.matchAll(/(?:^|[,/&?])w_(\d{1,4})(?=[,/&?]|$)/gi)) {
    width = Number(match[1]);
  }
  for (const match of url.matchAll(/(?:^|[,/&?])h_(\d{1,4})(?=[,/&?]|$)/gi)) {
    height = Number(match[1]);
  }

  // Query / semicolon forms: w=32, width=32, h=32, height=32.
  try {
    const parsed = new URL(url);
    for (const [key, raw] of parsed.searchParams) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) continue;
      const k = key.toLowerCase();
      if (k === "w" || k === "width") width = n;
      if (k === "h" || k === "height") height = n;
    }
  } catch {
    // Non-absolute URLs still get path-segment parsing above.
  }

  return { width, height };
}

/** True when the URL forces both width and height below {@link TINY_FORCED_EDGE_PX}. */
export function hasTinyForcedDimensions(url: string): boolean {
  const { width, height } = parseForcedMediaDimensions(url);
  if (width == null || height == null) return false;
  return width <= TINY_FORCED_EDGE_PX && height <= TINY_FORCED_EDGE_PX;
}

/** Returns true when a URL points at junk we never want to mirror or promote. */
export function isJunkMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (url.startsWith("data:")) return true;
  if (/(?:^|\/)favicon[.-]/i.test(url)) return true;
  if (hasTinyForcedDimensions(url)) return true;
  return (
    SMALL_MEDIA_MARKERS.some((marker) => url.includes(marker)) ||
    CHROME_MEDIA_MARKERS.some((marker) => url.includes(marker))
  );
}

/** Drop junk items (favicons, avatars, data URIs, emoji sprites, CI badges). */
export function filterJunkMedia<T extends { url: string }>(media: readonly T[]): T[] {
  return media.filter((m) => !isJunkMediaUrl(m.url));
}
