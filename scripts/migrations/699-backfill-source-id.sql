-- #699 Phase D — backfill source_id on usage_log from the existing source_slug.
--
-- Run AFTER both 20260503162734_usage_log_source_id.sql (ALTER TABLE ... ADD
-- COLUMN) and 20260503162735_sources_slug_index.sql (CREATE INDEX
-- idx_sources_slug) have been applied. The standalone slug index keeps the
-- correlated subquery below from full-scanning sources for every usage_log
-- row. This is a best-effort JOIN: rows whose source_slug no longer matches
-- any sources.slug (deleted sources) are left with source_id = NULL and
-- that's acceptable — they are historical.
--
-- Because sources.slug is only unique per-org since #690, ambiguous slugs
-- (the same slug under multiple orgs) are deliberately skipped — the
-- correlated subquery uses HAVING COUNT(*) = 1 so only unambiguous
-- slug-to-source mappings are resolved. Rows whose slug matches multiple
-- sources stay with source_id NULL; their source_slug fallback continues
-- to carry the original (ambiguous) attribution for human review. Run the
-- verification query below after backfilling to count any unresolved rows.
--
-- Runbook:
--
--   # Staging:
--   bunx wrangler d1 execute DB --env staging --remote \
--     --config workers/api/wrangler.jsonc \
--     --file=scripts/migrations/699-backfill-source-id.sql
--
--   # Prod:
--   bunx wrangler d1 execute released-db --remote \
--     --config workers/api/wrangler.jsonc \
--     --file=scripts/migrations/699-backfill-source-id.sql
--
-- Verification (run after applying to confirm coverage):
--
--   SELECT
--     COUNT(*) AS total_rows,
--     SUM(CASE WHEN source_slug IS NOT NULL AND source_id IS NULL THEN 1 ELSE 0 END) AS unresolved,
--     SUM(CASE WHEN source_id IS NOT NULL THEN 1 ELSE 0 END) AS resolved
--   FROM usage_log;
--
-- DO NOT run this file directly via `bun run db:migrate` — it must be
-- executed via `wrangler d1 execute --file=` (see the Phase C rebuild notes
-- in scripts/migrations/690-phase-c-rebuild.sql for why).

-- Only resolve unambiguous slugs. Per-org uniqueness (#690) means a slug
-- can match multiple source rows across orgs; assigning to the first match
-- would silently misattribute historical usage. Rows whose slug matches
-- multiple sources stay NULL — their source_slug fallback continues to
-- carry the original (ambiguous) attribution for human review.
UPDATE usage_log
SET source_id = (
  SELECT MIN(id)
  FROM sources
  WHERE slug = usage_log.source_slug
  GROUP BY slug
  HAVING COUNT(*) = 1
)
WHERE source_id IS NULL
  AND source_slug IS NOT NULL;
