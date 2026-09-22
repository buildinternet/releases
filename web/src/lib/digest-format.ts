/** Human label for a weekly digest's ET Monday `weekStart` (YYYY-MM-DD). */
export function weekOfLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  return `Week of ${start.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
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
  const part = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    d.toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const sameMonth = sameYear && start.getUTCMonth() === end.getUTCMonth();
  const withYear = year && !sameYear;
  const from = part(start, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
  const to = part(end, sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" });
  return year ? `${from} – ${to}, ${end.getUTCFullYear()}` : `${from} – ${to}`;
}
