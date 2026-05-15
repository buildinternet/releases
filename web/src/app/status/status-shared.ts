const timeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

/**
 * Format an ISO timestamp (or epoch ms number) as a short, timezone-aware
 * string: "May 15, 14:02 PDT".
 *
 * Shared across all status-page tabs.
 */
export function formatStatusTimestamp(ts: string | number): string {
  const parts = timeFormatter.formatToParts(new Date(ts));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")} ${get("day")}, ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}
