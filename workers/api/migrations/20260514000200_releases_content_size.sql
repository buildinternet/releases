-- Cache release content size so feed surfaces can advertise "this release is
-- ~1.5K tokens" without round-tripping the body for every row. #958.
--
--   content_chars  — raw LENGTH(content). Free to compute on read, cached
--                    here so cron/feed handlers don't bind the full body just
--                    to call LENGTH() on it.
--   content_tokens — js-tiktoken cl100k_base count (see
--                    @buildinternet/releases-core/tokens). BPE encoding is
--                    ~ms per release, so the upsert path computes once and
--                    the read path emits the cached value.
--
-- Nullable: pre-existing rows don't have values, and the backfill script
-- (scripts/backfill-content-sizes.ts) populates them out-of-band. Renderers
-- treat NULL as "size unknown" — the column is purely advisory.
--
-- `releases_visible` is `SELECT releases.*` so SQLite picks up the new
-- columns automatically; no view recreation needed.
ALTER TABLE releases ADD COLUMN content_chars INTEGER;
ALTER TABLE releases ADD COLUMN content_tokens INTEGER;
