/**
 * Timestamp for the source sidebar's "Last Checked" / "Last Published" item.
 *
 * Poll-fed sources show the last poll (falling back to the last successful
 * fetch). Push-fed sources (`metadata.ingestMode = "push"`, #2374) are never
 * polled, so `lastPolledAt` is frozen at the last poll before the switch;
 * they show the last publish instead — the later of `lastFetchedAt` (stamped
 * by every successful `releases/batch` write) and the newest release date.
 * Same "last activity" definition as `apps/api/src/cron/push-staleness.ts`.
 */
export function sourceLastActivityAt(
  source: {
    lastPolledAt: string | null;
    lastFetchedAt: string | null;
    latestDate: string | null;
  },
  pushFed: boolean,
): string | null {
  if (!pushFed) return source.lastPolledAt ?? source.lastFetchedAt;
  return latestIso(source.lastFetchedAt, source.latestDate);
}

function latestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(tb)) return a;
  if (Number.isNaN(ta)) return b;
  return tb > ta ? b : a;
}
