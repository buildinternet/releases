import { logEvent } from "@releases/lib/log-event";

/**
 * Rebuild every `source_release_stats` row from `releases_visible` and report
 * how many rows had drifted from the trigger-maintained values. The triggers
 * (migration 20261104230000) keep the table current on every write, so drift
 * should be zero; a non-zero count means a write path the triggers don't cover
 * (or a trigger bug), and this run has already corrected it.
 *
 * Reads every visible release once (~150K rows), so it runs on the daily
 * `0 4 * * *` tick rather than hourly. Only rows whose values actually changed
 * are written.
 */
export async function reconcileSourceReleaseStats(
  d1: Pick<D1Database, "prepare">,
): Promise<{ drifted: number }> {
  const res = await d1
    .prepare(
      `INSERT INTO source_release_stats (source_id, release_count, first_published_at, last_published_at, updated_at)
       SELECT s.id, COUNT(r.id), MIN(r.published_at), MAX(r.published_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       FROM sources s
       LEFT JOIN releases_visible r ON r.source_id = s.id
       WHERE true
       GROUP BY s.id
       -- A source with no releases and no row yet reads as 0 already (readers
       -- COALESCE), so don't count creating its row as drift.
       HAVING COUNT(r.id) > 0 OR EXISTS (SELECT 1 FROM source_release_stats x WHERE x.source_id = s.id)
       ON CONFLICT(source_id) DO UPDATE SET
         release_count = excluded.release_count,
         first_published_at = excluded.first_published_at,
         last_published_at = excluded.last_published_at,
         updated_at = excluded.updated_at
       WHERE source_release_stats.release_count IS NOT excluded.release_count
          OR source_release_stats.first_published_at IS NOT excluded.first_published_at
          OR source_release_stats.last_published_at IS NOT excluded.last_published_at`,
    )
    .bind()
    .run();
  const drifted = Number(res.meta?.changes ?? 0);
  logEvent(drifted > 0 ? "warn" : "info", {
    component: "source-release-stats",
    event: "reconcile",
    drifted,
  });
  return { drifted };
}
