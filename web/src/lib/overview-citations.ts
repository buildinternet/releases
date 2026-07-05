import type { OverviewCitation } from "@buildinternet/releases-api-types";

/**
 * Overview citations are a Sources *list*, not span-anchored provenance (#1934):
 * each is a source the overview drew on, rendered as a chip in the footer. There
 * are no body char offsets and no inline superscripts — that machinery (and its
 * verbatim-quote contract) was removed. What survives here is the chip's label +
 * href resolution.
 */

/** Strip a stray leading markdown heading so the org page header isn't doubled. */
export function stripLeadingHeading(content: string): string {
  return content.replace(/^\s*#{1,6}\s+[^\n]+\n+/, "");
}

/**
 * Chip label. Prefer the citation's own title (the release / source title);
 * fall back to a hostname-shaped label so the footer never reads "undefined".
 */
export function definitionLabel(c: OverviewCitation): string {
  if (c.title && c.title.trim()) return c.title.trim();
  if (!URL.canParse(c.sourceUrl)) return c.sourceUrl;
  const u = new URL(c.sourceUrl);
  return u.hostname + u.pathname;
}

/**
 * Chip href: the canonical internal release page when the source resolved to an
 * on-registry release (#1934) — crawlable, on-domain, keeps link equity inside
 * the registry — else the external source URL.
 */
export function citationHref(c: OverviewCitation): string {
  return c.releaseWebUrl ?? c.sourceUrl;
}

/** True when the chip links to an on-registry release page rather than an external source. */
export function isInternalCitation(c: OverviewCitation): boolean {
  return !!c.releaseWebUrl;
}
