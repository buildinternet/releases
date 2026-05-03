-- #699 Phase D — backfill source_id on usage_log from the existing source_slug.
--
-- Run AFTER the 20260503162734_usage_log_source_id.sql migration has been
-- applied (ALTER TABLE ... ADD COLUMN). This is a best-effort JOIN: rows
-- whose source_slug no longer matches any sources.slug (deleted sources) are
-- left with source_id = NULL and that's acceptable — they are historical.
--
-- Because sources.slug is only unique per-org since #690, the LIMIT 1 guard
-- picks the first matching source row when multiple orgs share the same slug
-- (rare in practice but possible). Run the verification query below after
-- backfilling to check for any ambiguous cases.
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

UPDATE usage_log
SET source_id = (
  SELECT id FROM sources WHERE slug = usage_log.source_slug LIMIT 1
)
WHERE source_id IS NULL
  AND source_slug IS NOT NULL;
