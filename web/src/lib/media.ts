import { cfImageUrl } from "@releases/rendering/media-url";

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
 * Downscaled thumbnail URL for a release-media image. When the rollout flag is
 * on, routes the image through a Cloudflare width transform so the browser gets
 * an appropriately-sized variant instead of squeezing a full-resolution
 * original into a small box. When off, returns `src` unchanged.
 *
 * Call sites should render the result with next/image `unoptimized` (see
 * {@link IMG_TRANSFORM_ON}) — the image is already CF-optimized, so Vercel must
 * not re-process it (and `media.releases.sh` is in `remotePatterns`, which would
 * otherwise trigger a second optimization pass + billing).
 */
export function releaseThumbUrl(src: string, width: number): string {
  if (!IMG_TRANSFORM_ON) return src;
  return cfImageUrl(src, { origin: MEDIA_ORIGIN, width });
}
