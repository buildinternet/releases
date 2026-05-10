/**
 * Pure helpers for the /status Sources tab "Pending fetch" badge. The raw
 * `changeDetectedAt IS NOT NULL` check produced false positives — the flag
 * only clears when scrape-fetch reaches `updateSourceAfterFetch`, so any
 * fetch that errors before that point leaves a stale flag behind that the
 * old badge advertised as if the fetch were queued.
 *
 * This helper compares `changeDetectedAt` against `lastFetchedAt` so stale
 * flags fall away, and surfaces a separate "Stuck" state when a flag has
 * outlived the daily scrape-agent-sweep cycle (a strong signal that the
 * sweep keeps trying and failing).
 */

export type FetchPendingTone = "pending" | "stuck";

export type FetchPendingStatus =
  | { tone: FetchPendingTone; label: string; tooltip: string }
  | { tone: null };

/**
 * scrape-agent-sweep runs at 01:00 UTC daily, so a flag younger than ~24h
 * may legitimately just be waiting for the next sweep. Past that, every
 * sweep window since flag-set has had a chance and hasn't cleared it —
 * something's failing. 36h is "more than one cycle, with slack for cron
 * skew and discovery latency."
 */
export const STUCK_AFTER_MS = 36 * 60 * 60 * 1000;

interface SourceLike {
  type: string;
  changeDetectedAt?: string | null;
  lastFetchedAt?: string | null;
}

function toEpoch(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Evaluate whether a scrape/agent source's `changeDetectedAt` flag means
 * something the operator can act on. Returns `tone: null` for types/states
 * where the badge should be hidden entirely (feeds, github sources, cleared
 * flags, stale flags from past failed fetches).
 */
export function evaluateFetchPending(
  src: SourceLike,
  now: number = Date.now(),
): FetchPendingStatus {
  if (src.type !== "scrape" && src.type !== "agent") return { tone: null };
  const detected = toEpoch(src.changeDetectedAt);
  if (detected === 0) return { tone: null };

  const fetched = toEpoch(src.lastFetchedAt);
  // Stale flag: a fetch happened after the change was detected but didn't
  // clear the flag. The fetch already ran — there's nothing to wait on.
  // Don't advertise it as pending.
  if (detected <= fetched) return { tone: null };

  const age = now - detected;
  if (age > STUCK_AFTER_MS) {
    return {
      tone: "stuck",
      label: "Stuck",
      tooltip: `Change detected ${formatAge(age)} ago and the daily scrape-agent-sweep hasn't drained it. Most likely the discovery fetch keeps erroring before it can clear the flag — check the Fetch Log for status=error.`,
    };
  }
  return {
    tone: "pending",
    label: "Pending fetch",
    tooltip: `Change detected ${formatAge(age)} ago. The next scrape-agent-sweep (01:00 UTC) will drain it.`,
  };
}
