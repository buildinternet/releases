/** Sanitize URLs from user-generated markdown to prevent XSS via javascript: and other dangerous schemes. */

// `#…` covers same-page fragment links (heading anchors, TOC targets). They
// carry no scheme, so there's no javascript:/data: injection surface — a
// fragment can only ever point within the current document.
const SAFE_LINK_PATTERN = /^(https?:\/\/|mailto:|\/(?!\/)|#)/;
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

/** Returns true for a same-page fragment link (`#section`). These navigate
 *  within the current document, so they must NOT carry `target="_blank"` or the
 *  external-UGC rel — they're internal anchors (heading targets, TOC), not
 *  outbound links. */
export function isFragmentHref(href: string | undefined | null): boolean {
  return typeof href === "string" && href.trim().startsWith("#");
}

/** Same-origin app paths (`/submit`, `/docs/listing`, `/foo#bar`). These should
 *  stay in-document navigation in author-controlled markdown (docs, pages) —
 *  no `target="_blank"`, no external-UGC rel. Protocol-relative `//…` is
 *  deliberately excluded (that's `isSafeHref`'s job to reject). */
export function isInternalHref(href: string | undefined | null): boolean {
  if (!href || typeof href !== "string") return false;
  const trimmed = href.trim();
  return trimmed.startsWith("/") && !trimmed.startsWith("//");
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
    // remotePatterns only allows github.com paths matching `/*.png` (avatar
    // handles like github.com/{user}.png). Other github.com URLs — notably
    // user-attachments embedded in GitHub's own changelog — must fall through
    // to `unoptimized` or next/image will reject them at render time.
    /^https:\/\/github\.com\/[^/]+\.png(?:$|\?)/.test(url)
  );
}
