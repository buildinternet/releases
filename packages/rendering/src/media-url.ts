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
 * Also unwraps any `_next/image` / `_vercel/image` optimizer URLs embedded in
 * content bodies — those proxy endpoints 404 for off-origin fetchers, so
 * legacy records ingested before the unwrap fix still need to be rewritten
 * at read time.
 *
 * Returns the original string unchanged if it has no media references to
 * rewrite.
 */
export function hydrateMediaUrls(content: string, mediaOrigin: string): string {
  if (!content) return content;

  let out = unwrapImageProxyUrls(content);

  if (mediaOrigin && (out.includes("/_media/") || out.includes("/v1/media/"))) {
    const origin = mediaOrigin.endsWith("/") ? mediaOrigin.slice(0, -1) : mediaOrigin;
    out = out.replace(
      /(?:\/_media\/|https?:\/\/api\.releases\.sh\/v1\/media\/|\/v1\/media\/)([\w/.%-]+)/g,
      (_, key) => {
        const prefix = IMAGE_EXTENSIONS.test(key) ? `${origin}/${IMAGE_TRANSFORM}/` : `${origin}/`;
        return `${prefix}${key}`;
      },
    );
  }

  return out;
}

/**
 * Rewrite any absolute `_next/image` / `_vercel/image` optimizer URLs in a
 * content string to the underlying asset URL via `normalizeMediaUrl`. Safe
 * to call on content that doesn't contain any proxy URLs — it's a no-op in
 * that case.
 *
 * The content may contain raw URLs, markdown image links, or HTML-escaped
 * `&amp;` ampersands. We match `_next/image` / `_vercel/image` query-string
 * URLs up to the next whitespace, quote, closing bracket/paren, or `<`, then
 * HTML-unescape `&amp;` to `&` so `URL` can parse the query params. Inputs
 * with no proxy URLs (or malformed matches) are returned unchanged.
 */
export function unwrapImageProxyUrls(content: string): string {
  if (!content) return content;
  if (!content.includes("_next/image") && !content.includes("_vercel/image")) return content;

  return content.replace(
    /https?:\/\/[^\s"'<>)\]]*?\/_(?:next|vercel)\/image\?[^\s"'<>)\]]+/g,
    (match) => {
      const decoded = match.replace(/&amp;/g, "&");
      const unwrapped = normalizeMediaUrl(decoded);
      return unwrapped === decoded ? match : unwrapped;
    },
  );
}

/**
 * Paths that belong to image-proxy / optimizer endpoints (Next.js, Vercel).
 * Requests to these from off-origin crawlers typically 404 — Next's image
 * optimizer checks referer and is effectively same-origin. Always unwrap
 * to the underlying asset URL from the `url` query param.
 */
const IMAGE_PROXY_PATHS = ["/_next/image", "/_vercel/image"];

/**
 * Unwraps Next.js / Vercel image optimizer URLs to the underlying asset.
 * Matches exact path or any basePath-prefixed variant (e.g. Ramp's
 * `/product-releases/_next/image` when Next is mounted under a `basePath`).
 * Returns the input unchanged for non-proxy or malformed URLs.
 */
export function normalizeMediaUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const isProxy = IMAGE_PROXY_PATHS.some(
      (p) => parsed.pathname === p || parsed.pathname.endsWith(p),
    );
    if (isProxy) {
      const inner = parsed.searchParams.get("url");
      if (inner) return new URL(inner, parsed.origin).toString();
      return url;
    }
    // Fallback for mangled proxy URLs where the optimizer path landed in the
    // query string instead of the pathname — happens when a relative
    // `_next/image?url=…` got concatenated onto a source URL that carried its
    // own query (e.g. `/blog?category=changelog`), so `pathname` is just
    // `/blog` and the proxy check above misses. Recover the inner asset from
    // the proxy marker's `url=` param.
    const marker = url.match(/\/_(?:next|vercel)\/image\?(.+)$/);
    if (marker) {
      const inner = new URLSearchParams(marker[1]).get("url");
      if (inner) return new URL(inner, parsed.origin).toString();
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Wrap an absolute image URL in a Cloudflare Image Transformation that serves a
 * downscaled, format-negotiated variant from `origin`'s `/cdn-cgi/image/`
 * endpoint. Used for release-feed thumbnails / gallery images so the browser
 * isn't handed a full-resolution original to squeeze into a small box (the
 * one-pass downscale of a detailed screenshot aliases — "jagged" thumbs).
 *
 * The source is appended raw (Cloudflare's URL format parses everything after
 * the options segment as the source image), so query strings survive. Requires
 * `origin` to permit cross-origin sources for third-party URLs — same-zone keys
 * always work.
 *
 * Returns `src` unchanged (a safe passthrough) when there's nothing to gain or
 * the transform can't apply: empty `origin`, a non-absolute / non-http(s) /
 * unparseable URL, an SVG (vector — nothing to downscale), or a URL that is
 * already a `/cdn-cgi/image/` transform (no double-wrap). The caller is
 * expected to only pass URLs it knows are images.
 */
export function cfImageUrl(src: string, opts: { origin: string; width: number }): string {
  const { origin, width } = opts;
  if (!src || !origin) return src;
  if (src.includes("/cdn-cgi/image/")) return src;

  let parsed: URL;
  try {
    parsed = new URL(src);
  } catch {
    return src; // relative or malformed — no absolute source to fetch
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return src;
  if (/\.svg$/i.test(parsed.pathname)) return src;

  const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return `${base}/cdn-cgi/image/width=${width},quality=80,format=auto/${src}`;
}

/**
 * Build an absolute media URL from an R2 key, or undefined if no key.
 * Returns a plain URL without Image Transforms — gallery images go through
 * next/image which handles its own optimization.
 */
export function resolveR2Url(
  r2Key: string | undefined | null,
  mediaOrigin: string,
): string | undefined {
  if (!r2Key) return undefined;
  return `${mediaOrigin}/${r2Key}`;
}
