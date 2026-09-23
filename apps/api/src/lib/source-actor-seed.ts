/**
 * Seed-jitter for the SourceActor (#1776). The poll cron seeds each due source's
 * Durable Object with a first alarm (`ensureScheduled`); many sources are
 * simultaneously due, so seeding them all at `now` would re-create the thundering
 * herd the jitter smear exists to avoid. Spreading the first alarm across a small
 * window staggers them; after the first fetch each source's `last_polled_at`
 * differs, so subsequent alarms land at distinct times naturally (emergent jitter).
 *
 * (The rollout cohort predicate that used to live here — `parseCohortPct` /
 * `isSourceActorManaged` — was removed once the actor reached 100% and became the
 * sole per-source fetch driver; the cron is now a pure re-seed heartbeat.)
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

/** Window (ms) across which freshly-seeded source alarms are spread. */
export const SEED_JITTER_WINDOW_MS = 5 * 60 * 1000;

export function seedJitterMs(sourceId: string, windowMs: number = SEED_JITTER_WINDOW_MS): number {
  if (windowMs <= 0) return 0;
  return fnv1a32(sourceId) % windowMs;
}
