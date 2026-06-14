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

/** Relative time-window shorthand: `<n><unit>` where unit ∈ d/w/m/y. */
const RELATIVE_DATE_RE = /^(\d+)([dwmy])$/i;

/**
 * ISO-8601 we accept as an absolute bound: a date (`2026-01-01`, parsed as UTC
 * midnight) or a datetime that carries an explicit timezone — trailing `Z` or a
 * `±HH[:MM]` offset. A datetime WITHOUT a timezone (`2026-01-01T12:30:00`) is
 * deliberately not matched: `new Date()` would parse it as local time, so the
 * same input would resolve to different instants depending on the runtime.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?))?$/;

/**
 * Resolve a time-window query param to a canonical ISO-8601 UTC timestamp.
 *
 * Accepts either:
 *  - an absolute ISO-8601 date (`2026-01-01`, UTC midnight) or a
 *    timezone-qualified datetime (`2026-01-01T12:30:00Z`, `…+05:00`),
 *    normalized to `…T..:..:..Z`. A datetime without an explicit timezone is
 *    rejected — see `ISO_DATE_RE` — so resolution is runtime-independent; or
 *  - a small relative shorthand counted back from `now`: `90d` (days),
 *    `4w` (weeks), `6m` (months), `2y` (years). The unit is case-insensitive
 *    and surrounding whitespace is tolerated.
 *
 * Months and years use calendar arithmetic (`setUTCMonth` / `setUTCFullYear`),
 * so `6m` lands on the same day-of-month six months earlier; days and weeks use
 * exact 24h/7d math. Returns `null` for empty, fractional, negative, bad-unit,
 * or otherwise unparseable input so callers can map a miss to a 400 / error.
 *
 * `now` is injectable for deterministic tests; defaults to the current time.
 */
export function resolveDateParam(input: string, now: Date = new Date()): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const rel = trimmed.match(RELATIVE_DATE_RE);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isInteger(n) || n < 0) return null;
    const d = new Date(now.getTime());
    switch (rel[2].toLowerCase()) {
      case "d":
        d.setUTCDate(d.getUTCDate() - n);
        break;
      case "w":
        d.setUTCDate(d.getUTCDate() - n * 7);
        break;
      case "m":
        d.setUTCMonth(d.getUTCMonth() - n);
        break;
      case "y":
        d.setUTCFullYear(d.getUTCFullYear() - n);
        break;
    }
    return d.toISOString();
  }

  // Require strict ISO-8601 (date, or timezone-qualified datetime). This also
  // rejects the lenient shapes `new Date()` would otherwise accept — a bare
  // number (`90` → year 1990), `2026/01/01`, `Jan 1 2026`, and tz-less
  // datetimes — so a window bound is never ambiguous or runtime-dependent.
  if (!ISO_DATE_RE.test(trimmed)) return null;

  // The regex is structural; `new Date` still rejects impossible calendar
  // values like `2026-13-45` or `2026-02-29`.
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
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

// ── Eastern-Time day helpers ──────────────────────────────────────
// Daily collection summaries are bucketed by Eastern calendar day (the
// product audience + the self-changelog cron both use ET). No tz library:
// Intl handles the DST math.

const ET_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Eastern calendar day (`YYYY-MM-DD`) for a UTC instant. */
export function etDayKey(instant: string | Date): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return ET_DATE_FMT.format(d); // en-CA renders ISO-style YYYY-MM-DD
}

const ET_OFFSET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Offset (minutes east of UTC) of America/New_York at a given instant. */
function etOffsetMinutes(at: Date): number {
  const p = Object.fromEntries(ET_OFFSET_FMT.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Add (or subtract) whole days to a `YYYY-MM-DD` key, returning a `YYYY-MM-DD` key. */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** UTC instant of Eastern midnight starting `dateKey`. */
function etMidnightUtc(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = etOffsetMinutes(new Date(guess));
  return new Date(guess - offset * 60_000).toISOString();
}

/** The `[startUtc, endUtc)` instants bounding an Eastern calendar day. */
export function etDayBoundsUtc(dateKey: string): { startUtc: string; endUtc: string } {
  return {
    startUtc: etMidnightUtc(dateKey),
    endUtc: etMidnightUtc(addDaysToDateKey(dateKey, 1)),
  };
}
