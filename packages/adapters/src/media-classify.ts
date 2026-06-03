/**
 * Shared media-type classification by URL extension. Pure and dependency-free
 * so both the feed adapter (`feed.ts`) and the AI-extract funnel
 * (`extract/shared.ts`) agree on what counts as a GIF.
 *
 * The extract path otherwise inherits the model's `type`, which under-classifies
 * animated GIFs as "image" — the extraction prompt only ever names "image" and
 * "video" — leaving heavy GIFs mistyped at ingest (#1368). A deterministic
 * post-pass keyed on the URL is the robust fix; relying on the model is not.
 */

/**
 * True when `url`'s path ends in `.gif` (query string ignored). Robust to
 * image-resize wrapper URLs whose path ends in the wrapped source `.gif`
 * (e.g. Firecrawl/beehiiv `…/cdn-cgi/image/…/subscribe_forms.gif`).
 */
export function isGifUrl(url: string): boolean {
  return url.split("?")[0]!.toLowerCase().endsWith(".gif");
}

/**
 * Classify a URL by file extension into the MediaRef type union.
 * `.gif` → "gif"; `.mp4`/`.webm`/`.mov` → "video"; everything else → "image".
 */
export function classifyMediaType(url: string): "image" | "video" | "gif" {
  if (isGifUrl(url)) return "gif";
  const lower = url.split("?")[0]!.toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov")) return "video";
  return "image";
}
