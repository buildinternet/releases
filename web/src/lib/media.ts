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
