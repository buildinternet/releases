import { cfImageUrl, cfMediaUrl } from "@releases/rendering/media-url";

/** R2 / Cloudflare media origin (carries the `/cdn-cgi/image/` transform endpoint). */
const MEDIA_ORIGIN = "https://media.releases.sh";

/**
 * Rollout flag for serving downscaled release-media thumbnails through
 * Cloudflare Image Transformations. Default OFF: until cross-origin transforms
 * are enabled on the `media.releases.sh` zone, `releaseThumbUrl` is a
 * passthrough so behavior is identical to today (no broken-image window).
 *
 * `NEXT_PUBLIC_*` is inlined at build time, so this is a static literal in the
 * client bundle.
 */
export const IMG_TRANSFORM_ON = process.env.NEXT_PUBLIC_RELEASES_IMG_TRANSFORM === "true";

/**
 * Pure core of {@link releaseThumbUrl}, parameterized on the flag + origin so
 * both states are unit-testable without juggling the build-time env const.
 *
 * Only **same-origin** sources (already on the media origin — i.e. R2-hosted,
 * `r2Url`) are routed through the Cloudflare width transform. Third-party
 * sources pass through untransformed: once ingest-time R2 upload (#1177) makes
 * media same-origin, the Cloudflare Transformations "Sources" setting is
 * tightened back to "Specified origins", at which point a cross-origin
 * `/cdn-cgi/image/.../<third-party-url>` 403s. Gating to same-origin means we
 * never emit such a URL — un-uploaded media renders untransformed (jagged but
 * never broken) rather than hitting the error placeholder.
 */
export function thumbUrl(
  src: string,
  width: number,
  opts: { enabled: boolean; origin: string },
): string {
  if (!opts.enabled) return src;
  // Exact origin match — a `startsWith` prefix check would treat a hostile host
  // like `media.releases.sh.evil.com` as same-origin. Relative/malformed URLs
  // throw and pass through untransformed.
  let parsed: URL;
  try {
    parsed = new URL(src);
  } catch {
    return src;
  }
  if (parsed.origin !== opts.origin) return src; // third-party → passthrough
  return cfImageUrl(src, { origin: opts.origin, width });
}

/**
 * Downscaled thumbnail URL for a release-media image. When the rollout flag is
 * on, routes a same-origin (R2-hosted) image through a Cloudflare width
 * transform so the browser gets an appropriately-sized variant instead of
 * squeezing a full-resolution original into a small box. When off — or for a
 * third-party source — returns `src` unchanged.
 *
 * Call sites should render the result with next/image `unoptimized` (see
 * {@link IMG_TRANSFORM_ON}) — the image is already CF-optimized, so Vercel must
 * not re-process it (and `media.releases.sh` is in `remotePatterns`, which would
 * otherwise trigger a second optimization pass + billing).
 */
export function releaseThumbUrl(src: string, width: number): string {
  return thumbUrl(src, width, { enabled: IMG_TRANSFORM_ON, origin: MEDIA_ORIGIN });
}

/**
 * Rollout flag for serving heavy animated GIFs as Cloudflare Media
 * Transformations MP4 (`<video>`) instead of full-size GIF `<img>`. Default OFF:
 * flag-off renders GIFs exactly as today. `NEXT_PUBLIC_*` is inlined at build
 * time, so this is a static literal in the client bundle.
 */
export const MEDIA_VIDEO_ON = process.env.NEXT_PUBLIC_RELEASES_MEDIA_VIDEO === "true";

/**
 * True when `src` points at a GIF (by `.gif` pathname). Used to route heavy
 * animated GIFs through an MP4 transform. Robust to stored items that are
 * mistyped `image` (e.g. Firecrawl-ingested GIFs whose URL is a `cdn-cgi/image`
 * wrapper ending in `.gif`). Unparseable inputs are not GIFs.
 */
export function isGifSrc(src: string): boolean {
  try {
    return /\.gif$/i.test(new URL(src).pathname);
  } catch {
    return false;
  }
}

/**
 * Pure decision (parameterized on the flag for testability): render a media item
 * as an MP4 `<video>` rather than an `<img>`. True for a `gif`-typed item or any
 * `.gif` source, when the rollout flag is enabled.
 */
export function shouldRenderAsVideo(opts: {
  type?: string;
  src: string;
  enabled: boolean;
}): boolean {
  if (!opts.enabled) return false;
  return opts.type === "gif" || isGifSrc(opts.src);
}

/**
 * The Cloudflare Media Transformations MP4 URL for a GIF source. Third-party and
 * R2-hosted sources both work (cross-origin transforms are permitted on the
 * media zone). See {@link cfMediaUrl}.
 */
export function releaseVideoUrl(src: string): string {
  return cfMediaUrl(src, { origin: MEDIA_ORIGIN });
}
