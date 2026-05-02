-- releases_visible: collapses the two filters every read site applies so
-- callers don't have to repeat them. #675
--
-- Excludes:
--   - suppressed releases  (suppressed = 1)
--   - coverage-side releases  (rows that ARE covered by another release)
--
-- Non-materialized — SQLite inlines the WHERE into the outer query,
-- so there's no extra fan-out cost.
CREATE VIEW IF NOT EXISTS releases_visible AS
  SELECT releases.*
  FROM releases
  WHERE (releases.suppressed IS NULL OR releases.suppressed = 0)
    AND NOT EXISTS (
      SELECT 1 FROM release_coverage
      WHERE release_coverage.coverage_id = releases.id
    );
