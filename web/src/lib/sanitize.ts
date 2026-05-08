/** Sanitize URLs from user-generated markdown to prevent XSS via javascript: and other dangerous schemes. */

const SAFE_LINK_PATTERN = /^(https?:\/\/|mailto:|\/(?!\/))/;
const SAFE_IMG_PATTERN = /^https?:\/\//;

/**
 * Rel attribute for outbound links to externally-sourced (scraped) content
 * — release/changelog bodies, release canonical URLs, and any URL we did
 * not author ourselves. `ugc` flags the link as third-party content per
 * https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links;
 * `nofollow` keeps us from passing PageRank to arbitrary scraped destinations;
 * `noopener noreferrer` is the standard cross-window safety pair.
 */
export const EXTERNAL_UGC_REL = "nofollow ugc noopener noreferrer";

/** Returns true if the href is safe for use in an <a> tag. */
export function isSafeHref(href: string | undefined | null): href is string {
  if (!href || typeof href !== "string") return false;
  return SAFE_LINK_PATTERN.test(href.trim());
}

/** Returns true if the src is safe for use in an <img> tag. */
export function isSafeImgSrc(src: string | undefined | null): src is string {
  if (!src || typeof src !== "string") return false;
  return SAFE_IMG_PATTERN.test(src.trim());
}

/** Returns true if the image URL can be optimized via next/image (matches our remotePatterns). */
export function isOptimizableImage(url: string): boolean {
  return (
    url.includes("githubusercontent.com") ||
    url.includes("media.releases.sh") ||
    url.includes("/v1/media/") ||
    url.includes("github.com/")
  );
}
