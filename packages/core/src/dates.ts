const MONTH_TITLE_RE =
  /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})$/i;

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

/**
 * If `title` is exactly a month + 4-digit year (century 2000 only, e.g.
 * "March 2026" or "march 2026"), returns the ISO-8601 string for the first
 * of that month at UTC midnight: `YYYY-MM-01T00:00:00.000Z`.
 *
 * Returns `null` for any non-matching input (trailing punctuation, century
 * 1900, partial matches). Leading/trailing whitespace is tolerated.
 *
 * Used in the API ingest path as a deterministic fallback when the AI extractor
 * returns `publishedAt: null` for month-labeled changelog sections.
 */
export function inferMonthOnlyDate(title: string): string | null {
  const m = title.trim().match(MONTH_TITLE_RE);
  if (!m) return null;
  const month = MONTH_INDEX[m[1].toLowerCase()];
  const year = Number(m[2]);
  return new Date(Date.UTC(year, month, 1)).toISOString();
}

export function elapsedSec(startTime: number): string {
  return ((performance.now() - startTime) / 1000).toFixed(1);
}

export function elapsedFormatted(startTime: number): string {
  const totalSec = (performance.now() - startTime) / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = Math.round(totalSec % 60);
  return `${mins}m ${secs}s`;
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function timeAgo(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
