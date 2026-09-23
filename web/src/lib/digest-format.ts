/** Human label for a weekly digest's ET Monday `weekStart` (YYYY-MM-DD). */
export function weekOfLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  return `Week of ${start.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}

let shortMonthDayFormatter: Intl.DateTimeFormat | undefined;

/** "Sep 14" — short month + numeric day, UTC. Cached module-level formatter
 *  since this is called per-row in feeds/timelines. */
export function shortMonthDayLabel(date: string): string {
  shortMonthDayFormatter ??= new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return shortMonthDayFormatter.format(new Date(`${date}T00:00:00Z`));
}

/** "Week of Sep 14" — a week divider's short label. Distinct from
 *  `weekOfLabel` (long month + year, used for page titles/metadata) and
 *  `weekRangeLabel` (a Monday–Sunday span); the divider needs neither. */
export function weekDividerLabel(weekStart: string): string {
  return `Week of ${shortMonthDayLabel(weekStart)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Monday–Sunday range for a digest's `weekStart`: "Sep 14 – 20, 2026",
 *  "Aug 31 – Sep 6, 2026", or "Dec 28, 2026 – Jan 3, 2027". `year: false`
 *  drops the year ("Sep 14 – 20") for surfaces that already date the week. */
export function weekRangeLabel(
  weekStart: string,
  { year = true }: { year?: boolean } = {},
): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(start.getTime() + 6 * DAY_MS);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const sameMonth = sameYear && start.getUTCMonth() === end.getUTCMonth();
  const withYear = year && !sameYear;
  const from = withYear
    ? start.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : shortMonthDayLabel(weekStart);
  const to = sameMonth
    ? end.toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" })
    : end.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return year ? `${from} – ${to}, ${end.getUTCFullYear()}` : `${from} – ${to}`;
}
