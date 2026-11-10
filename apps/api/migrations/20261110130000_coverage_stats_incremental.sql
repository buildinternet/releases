-- Make the release_coverage INSERT trigger on source_release_stats incremental.
--
-- The original trigger (20261104230000) recomputed the covered release's whole
-- source from `releases_visible` on every inserted link. Ingest links coverage
-- in batches (version lines, sibling packages, often ~80 rows at a time) on the
-- largest GitHub sources, so one batch INSERT re-read the same source once per
-- row: prod insights showed ~520K rows read per statement, the second-largest
-- D1 read consumer.
--
-- A new link moves exactly one release to the coverage side. It was visible
-- iff it isn't suppressed: it can't already be on the coverage side, because
-- coverage_id is the primary key (an upsert that changes coverage_id goes
-- through the AFTER UPDATE trigger, which still recomputes). So:
--   * decrement release_count by one when the release isn't suppressed;
--   * re-read first/last published_at only when the release held one of
--     them, as a single-row walk of idx_releases_source_published from either
--     end (stops at the first visible row).
-- The daily reconcile (`reconcileSourceReleaseStats`) still rebuilds every row
-- and logs drift. The DELETE and UPDATE triggers are rare and keep recomputing.

DROP TRIGGER IF EXISTS source_release_stats_coverage_ai;

CREATE TRIGGER IF NOT EXISTS source_release_stats_coverage_ai
AFTER INSERT ON release_coverage
BEGIN
  UPDATE source_release_stats
  SET
    release_count = release_count - 1,
    first_published_at = CASE
      WHEN (SELECT published_at FROM releases WHERE id = NEW.coverage_id) = first_published_at
      THEN (SELECT rv.published_at FROM releases_visible rv
            WHERE rv.source_id = source_release_stats.source_id
              AND rv.published_at IS NOT NULL
            ORDER BY rv.published_at ASC LIMIT 1)
      ELSE first_published_at
    END,
    last_published_at = CASE
      WHEN (SELECT published_at FROM releases WHERE id = NEW.coverage_id) = last_published_at
      THEN (SELECT rv.published_at FROM releases_visible rv
            WHERE rv.source_id = source_release_stats.source_id
              AND rv.published_at IS NOT NULL
            ORDER BY rv.published_at DESC LIMIT 1)
      ELSE last_published_at
    END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE source_id = (
    SELECT source_id FROM releases
    WHERE id = NEW.coverage_id AND COALESCE(suppressed, 0) = 0
  );
END;
