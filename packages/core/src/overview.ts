/**
 * Overview is considered stale beyond this many days. CLI and MCP both warn
 * (but still show) when an overview's `generatedAt` is older than this.
 */
export const OVERVIEW_STALE_DAYS = 30;

/** Default preview length when truncating overview content for inline display. */
export const OVERVIEW_PREVIEW_WORDS = 80;

export interface OverviewMeta {
  generatedAt: string;
  updatedAt?: string | null;
  lastContributingReleaseAt?: string | null;
}

export function overviewAgeDays(generatedAt: string, now: number = Date.now()): number {
  const ms = now - new Date(generatedAt).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

export function isOverviewStale(generatedAt: string, now: number = Date.now()): boolean {
  return overviewAgeDays(generatedAt, now) > OVERVIEW_STALE_DAYS;
}

/**
 * Strip a stray leading markdown heading. The overview prompt forbids
 * headings, but the model occasionally emits one anyway and it ruins
 * previews.
 */
function stripLeadingHeading(content: string): string {
  return content.replace(/^\s*#{1,6}\s+[^\n]+\n+/, "");
}

/**
 * Shorten an overview body to a preview suitable for inline display.
 *
 * Cuts at the end of the first paragraph if it falls within `maxWords`,
 * otherwise truncates at the nearest word boundary and appends an ellipsis.
 * Leaves the input unchanged when it already fits.
 */
export function overviewPreview(content: string, maxWords: number = OVERVIEW_PREVIEW_WORDS): string {
  const trimmed = stripLeadingHeading(content.trim());
  if (!trimmed) return "";

  const firstParaEnd = trimmed.indexOf("\n\n");
  const firstPara = firstParaEnd === -1 ? trimmed : trimmed.slice(0, firstParaEnd);
  const firstParaWords = firstPara.split(/\s+/).length;

  if (firstParaWords <= maxWords) return firstParaEnd === -1 ? trimmed : firstPara;

  const words = trimmed.split(/\s+/);
  if (words.length <= maxWords) return trimmed;
  return words.slice(0, maxWords).join(" ") + "…";
}
