/**
 * Portable media URL handling.
 *
 * Content stores media references as `/_media/{r2Key}` — a stable,
 * domain-free prefix. At read time, hydrate to the current media origin.
 * This avoids baking domains into stored content and eliminates the need
 * for migrations when the serving domain changes.
 */

/** Prefix written into release content at fetch/ingest time. */
export const MEDIA_PREFIX = "/_media/";

/** Cloudflare Image Transformation params applied to raster images. */
const IMAGE_TRANSFORM = "cdn-cgi/image/width=1200,quality=80,format=auto";

/** Extensions eligible for Image Transformations (not SVG — it's vector). */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif)$/i;

/**
 * Replace portable `/_media/` prefixes (and legacy `/v1/media/` references)
 * in content with the given media origin URL. Raster image URLs get
 * Cloudflare Image Transformation params for automatic resize + format negotiation.
 *
 * Returns the original string unchanged if mediaOrigin is empty or
 * content contains no media references.
 */
export function hydrateMediaUrls(content: string, mediaOrigin: string): string {
  if (!mediaOrigin || !content) return content;
  if (!content.includes("/_media/") && !content.includes("/v1/media/")) return content;

  const origin = mediaOrigin.endsWith("/") ? mediaOrigin.slice(0, -1) : mediaOrigin;

  return content.replace(
    /(?:\/_media\/|https?:\/\/api\.releases\.sh\/v1\/media\/|\/v1\/media\/)([\w/.%-]+)/g,
    (_, key) => {
      const prefix = IMAGE_EXTENSIONS.test(key) ? `${origin}/${IMAGE_TRANSFORM}/` : `${origin}/`;
      return `${prefix}${key}`;
    },
  );
}

/**
 * Build an absolute media URL from an R2 key, or undefined if no key.
 * Returns a plain URL without Image Transforms — gallery images go through
 * next/image which handles its own optimization.
 */
export function resolveR2Url(r2Key: string | undefined | null, mediaOrigin: string): string | undefined {
  if (!r2Key) return undefined;
  return `${mediaOrigin}/${r2Key}`;
}
