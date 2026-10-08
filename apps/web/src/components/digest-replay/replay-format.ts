/**
 * Display labels for the replay. Day keys are calendar dates, so they format
 * in UTC; clock times are the release's own ET time.
 */

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", opts);

const DAY_LONG = fmt({ weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const WEEKDAY = fmt({ weekday: "short", timeZone: "UTC" });
const WEEKDAY_NARROW = fmt({ weekday: "narrow", timeZone: "UTC" });
const DAY_NUM = fmt({ day: "numeric", timeZone: "UTC" });
const TIME_ET = fmt({ hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

const atNoon = (dayKey: string) => new Date(`${dayKey}T12:00:00Z`);

/** "Tue, Sep 29" */
export const dayLabel = (dayKey: string) => DAY_LONG.format(atNoon(dayKey));
/** "Tue 29" — river column header. */
export const columnLabel = (dayKey: string) =>
  `${WEEKDAY.format(atNoon(dayKey))} ${DAY_NUM.format(atNoon(dayKey))}`;
/** "T" — river column header at phone width. */
export const columnLetter = (dayKey: string) => WEEKDAY_NARROW.format(atNoon(dayKey));
/** "3:26 PM" in New York. */
export const timeLabel = (iso: string) => TIME_ET.format(new Date(iso));

/** CSS `left` for a week-time position in days. */
export const weekPct = (days: number) => `${((days / 7) * 100).toFixed(3)}%`;
