/**
 * Cohort predicate for the SourceActor rollout (#1776). A source is driven by
 * its per-source Durable Object (instead of the hourly poll cron) iff:
 *   - the `SOURCE_ACTOR` binding is present (absent ⇒ cron fallback), AND
 *   - the `source-actor-enabled` flag is on, AND
 *   - the source falls in the rollout cohort: `fnv1a(sourceId) % 100 < cohortPct`.
 *
 * The percentage cohort gives a reversible, deterministic ramp: bump
 * `SOURCE_ACTOR_COHORT_PCT` to widen, flip the flag off for an instant rollback.
 * The SAME predicate gates the cron's fan-out split AND the actor's own alarm —
 * so flipping the flag off cleanly hands a source back to the cron with no
 * double-driving (a source is never run by both the cron and its actor).
 */

// FNV-1a, 32-bit. Cheap, deterministic, no Web Crypto dependency — the same
// hash the poll-and-fetch fan-out uses for its jitter slot.
function fnv1a32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic per-source start skew (ms) for the FIRST alarm a freshly-migrated
 * cohort schedules. At a flag flip many sources are simultaneously overdue, so
 * seeding them all at `now` would re-create the thundering herd the jitter smear
 * exists to avoid. Spreading the first alarm across a small window staggers them;
 * after the first fetch each source's `last_polled_at` differs, so subsequent
 * alarms land at distinct times naturally (emergent jitter).
 */
export const SEED_JITTER_WINDOW_MS = 5 * 60 * 1000;

export function seedJitterMs(sourceId: string, windowMs: number = SEED_JITTER_WINDOW_MS): number {
  if (windowMs <= 0) return 0;
  return fnv1a32(sourceId) % windowMs;
}

/** Parse `SOURCE_ACTOR_COHORT_PCT`, clamped to [0, 100]; unset/NaN ⇒ 0. */
export function parseCohortPct(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return 0;
  return Math.min(Math.max(n, 0), 100);
}

/**
 * Whether a source is SourceActor-managed. `enabled` is the resolved
 * `source-actor-enabled` flag, `cohortPct` the parsed percentage var, and
 * `hasBinding` whether `env.SOURCE_ACTOR` is bound.
 */
export function isSourceActorManaged(
  sourceId: string,
  enabled: boolean,
  cohortPct: number,
  hasBinding: boolean,
): boolean {
  if (!hasBinding || !enabled || cohortPct <= 0) return false;
  if (cohortPct >= 100) return true;
  return fnv1a32(sourceId) % 100 < cohortPct;
}
