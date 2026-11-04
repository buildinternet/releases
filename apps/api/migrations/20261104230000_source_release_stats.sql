-- Per-source release rollup, kept current by triggers.
--
-- The stats rollup, the org directory and the catalog used to count every
-- visible release (~150K rows) through `releases_visible` on every call, which
-- made them the top D1 read consumers and 1-3 s queries that block a
-- single-threaded database. They now sum this table (one row per source)
-- instead. "Last N days" counts are NOT stored here: they go stale by the hour,
-- so readers range-scan `idx_releases_published` for those.
--
-- `release_count` / `first_published_at` / `last_published_at` cover exactly
-- the rows `releases_visible` returns: not suppressed, and not the coverage
-- side of a `release_coverage` link. Source hide/delete and org hide are
-- read-time filters (readers join through `sources_visible` /
-- `organizations_active`), so they need no maintenance here.
--
-- Maintenance:
--   * INSERT on releases: increment in place. A brand-new row can't be on the
--     coverage side yet (release_coverage.coverage_id references it), so its
--     visibility is just its `suppressed` flag.
--   * Everything rarer (delete, suppress/unsuppress, published_at or source
--     move, coverage link/unlink) recomputes that one source's row from
--     `releases_visible`, a range read on idx_releases_source_suppressed_published.
--     Recompute is idempotent and sidesteps the order in which SQLite runs the
--     release_coverage ON DELETE CASCADE relative to these triggers.
--   * The recompute selects FROM sources, so it writes nothing while a source
--     is being hard-deleted (its stats row goes with it via ON DELETE CASCADE).
--   * A daily reconcile (`reconcileSourceReleaseStats`) rebuilds every row and
--     logs any drift.

CREATE TABLE IF NOT EXISTS source_release_stats (
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  release_count INTEGER NOT NULL DEFAULT 0,
  first_published_at TEXT,
  last_published_at TEXT,
  updated_at TEXT NOT NULL
);

-- `releases.suppressed` defaults to 0; normalize any legacy NULLs so the
-- visibility test is a plain equality. The view still accepts NULL.
UPDATE releases SET suppressed = 0 WHERE suppressed IS NULL;

-- Initial populate (same statement the daily reconcile runs).
INSERT INTO source_release_stats (source_id, release_count, first_published_at, last_published_at, updated_at)
SELECT s.id, COUNT(r.id), MIN(r.published_at), MAX(r.published_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM sources s
LEFT JOIN releases_visible r ON r.source_id = s.id
GROUP BY s.id
ON CONFLICT(source_id) DO UPDATE SET
  release_count = excluded.release_count,
  first_published_at = excluded.first_published_at,
  last_published_at = excluded.last_published_at,
  updated_at = excluded.updated_at;

CREATE TRIGGER IF NOT EXISTS source_release_stats_release_ai
AFTER INSERT ON releases
WHEN COALESCE(NEW.suppressed, 0) = 0
BEGIN
  INSERT INTO source_release_stats (source_id, release_count, first_published_at, last_published_at, updated_at)
  VALUES (NEW.source_id, 1, NEW.published_at, NEW.published_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(source_id) DO UPDATE SET
    release_count = release_count + 1,
    first_published_at = CASE
      WHEN excluded.first_published_at IS NULL THEN first_published_at
      WHEN first_published_at IS NULL OR excluded.first_published_at < first_published_at THEN excluded.first_published_at
      ELSE first_published_at END,
    last_published_at = CASE
      WHEN excluded.last_published_at IS NULL THEN last_published_at
      WHEN last_published_at IS NULL OR excluded.last_published_at > last_published_at THEN excluded.last_published_at
      ELSE last_published_at END,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS source_release_stats_release_ad
AFTER DELETE ON releases
BEGIN
  INSERT INTO source_release_stats (source_id, release_count, first_published_at, last_published_at, updated_at)
  SELECT s.id, agg.n, agg.first_at, agg.last_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM sources s,
    (SELECT COUNT(*) AS n, MIN(published_at) AS first_at, MAX(published_at) AS last_at
     FROM releases_visible WHERE source_id = OLD.source_id) agg
  WHERE s.id = OLD.source_id
  ON CONFLICT(source_id) DO UPDATE SET
    release_count = excluded.release_count,
    first_published_at = excluded.first_published_at,
    last_published_at = excluded.last_published_at,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS source_release_stats_release_au
AFTER UPDATE OF suppressed, published_at, source_id ON releases
WHEN OLD.suppressed IS NOT NEW.suppressed
  OR OLD.published_at IS NOT NEW.published_at
  OR OLD.source_id IS NOT NEW.source_id
BEGIN
  INSERT INTO source_release_stats (source_id, release_count, first_published_at, last_published_at, updated_at)
  SELECT s.id, agg.n, agg.first_at, agg.last_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM sources s,
    (SELECT COUNT(*) AS n, MIN(published_at) AS first_at, MAX(published_at) AS last_at
     FROM releases_visible WHERE source_id = NEW.source_id) agg
  WHERE s.id = NEW.source_id
  ON CONFLICT(source_id) DO UPDATE SET
    release_count = excluded.release_count,
    first_published_at = excluded.first_published_at,
    last_published_at = excluded.last_published_at,
    updated_at = excluded.updated_at;
  INSERT INTO source_release_stats (source_id, release_count, first_published_at, last_published_at, updated_at)
  SELECT s.id, agg.n, agg.first_at, agg.last_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM sources s,
    (SELECT COUNT(*) AS n, MIN(published_at) AS first_at, MAX(published_at) AS last_at
     FROM releases_visible WHERE source_id = OLD.source_id) agg
  WHERE s.id = OLD.source_id AND OLD.source_id IS NOT NEW.source_id
  ON CONFLICT(source_id) DO UPDATE SET
    release_count = excluded.release_count,
    first_published_at = excluded.first_published_at,
    last_published_at = excluded.last_published_at,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS source_release_stats_coverage_ai
AFTER INSERT ON release_coverage
BEGIN
  INSERT INTO source_release_stats (source_id, release_count, first_published_at, last_published_at, updated_at)
  SELECT s.id, agg.n, agg.first_at, agg.last_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM releases rel
    JOIN sources s ON s.id = rel.source_id,
    (SELECT COUNT(*) AS n, MIN(published_at) AS first_at, MAX(published_at) AS last_at
     FROM releases_visible
     WHERE source_id = (SELECT source_id FROM releases WHERE id = NEW.coverage_id)) agg
  WHERE rel.id = NEW.coverage_id
  ON CONFLICT(source_id) DO UPDATE SET
    release_count = excluded.release_count,
    first_published_at = excluded.first_published_at,
    last_published_at = excluded.last_published_at,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS source_release_stats_coverage_ad
AFTER DELETE ON release_coverage
BEGIN
  INSERT INTO source_release_stats (source_id, release_count, first_published_at, last_published_at, updated_at)
  SELECT s.id, agg.n, agg.first_at, agg.last_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM releases rel
    JOIN sources s ON s.id = rel.source_id,
    (SELECT COUNT(*) AS n, MIN(published_at) AS first_at, MAX(published_at) AS last_at
     FROM releases_visible
     WHERE source_id = (SELECT source_id FROM releases WHERE id = OLD.coverage_id)) agg
  WHERE rel.id = OLD.coverage_id
  ON CONFLICT(source_id) DO UPDATE SET
    release_count = excluded.release_count,
    first_published_at = excluded.first_published_at,
    last_published_at = excluded.last_published_at,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS source_release_stats_coverage_au
AFTER UPDATE OF coverage_id ON release_coverage
WHEN OLD.coverage_id IS NOT NEW.coverage_id
BEGIN
  INSERT INTO source_release_stats (source_id, release_count, first_published_at, last_published_at, updated_at)
  SELECT s.id, agg.n, agg.first_at, agg.last_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM releases rel
    JOIN sources s ON s.id = rel.source_id,
    (SELECT COUNT(*) AS n, MIN(published_at) AS first_at, MAX(published_at) AS last_at
     FROM releases_visible
     WHERE source_id = (SELECT source_id FROM releases WHERE id = OLD.coverage_id)) agg
  WHERE rel.id = OLD.coverage_id
  ON CONFLICT(source_id) DO UPDATE SET
    release_count = excluded.release_count,
    first_published_at = excluded.first_published_at,
    last_published_at = excluded.last_published_at,
    updated_at = excluded.updated_at;
  INSERT INTO source_release_stats (source_id, release_count, first_published_at, last_published_at, updated_at)
  SELECT s.id, agg.n, agg.first_at, agg.last_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM releases rel
    JOIN sources s ON s.id = rel.source_id,
    (SELECT COUNT(*) AS n, MIN(published_at) AS first_at, MAX(published_at) AS last_at
     FROM releases_visible
     WHERE source_id = (SELECT source_id FROM releases WHERE id = NEW.coverage_id)) agg
  WHERE rel.id = NEW.coverage_id
  ON CONFLICT(source_id) DO UPDATE SET
    release_count = excluded.release_count,
    first_published_at = excluded.first_published_at,
    last_published_at = excluded.last_published_at,
    updated_at = excluded.updated_at;
END;
