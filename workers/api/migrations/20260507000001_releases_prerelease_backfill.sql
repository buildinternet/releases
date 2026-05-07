-- Backfill `releases.prerelease` for rows ingested before the column existed.
--
-- The column itself defaults to 0 (see 20260507000000_releases_prerelease.sql),
-- but neither the cron upsert (`onConflictDoNothing`) nor the URL-conflict
-- upsert (`RELEASE_URL_UPSERT` only sets content/contentHash) will ever
-- backfill the flag on a re-fetch — so we must run a one-shot UPDATE here.
--
-- Cost note: every pre-existing row has `prerelease = 0`, so `WHERE prerelease
-- = 0` matches the entire releases table on first run. D1 handles this fine
-- at current scale, but schedule application during a low-traffic window if
-- prod row counts grow significantly before this runs.
--
-- Patterns mirror the SemVer-prerelease identifiers detected by
-- `isPrereleaseVersion()` in @buildinternet/releases-core/prerelease. SQLite
-- LIKE is case-insensitive for ASCII, so a single `%-{tag}%` pattern catches
-- both `-alpha` and `-Alpha`. We accept a small false-negative tail for rare
-- patterns (e.g. `1.0.0-M1` milestones, which `LIKE` can't anchor on the
-- digit suffix) — those rows will be marked correctly on their next clean
-- re-insert via the canonical ingest path.
UPDATE releases
SET prerelease = 1
WHERE prerelease = 0
  AND version IS NOT NULL
  AND (
    version LIKE '%-alpha%'
    OR version LIKE '%-beta%'
    OR version LIKE '%-rc%'
    OR version LIKE '%-pre%'        -- covers -pre and -preview
    OR version LIKE '%-nightly%'
    OR version LIKE '%-canary%'
    OR version LIKE '%-snapshot%'
    OR version LIKE '%-dev%'
    OR version LIKE '%-edge%'
    OR version LIKE '%-insider%'
    OR version LIKE '%-experimental%'
    OR version LIKE '%-early-access%'
    OR version LIKE '%-next%'
    OR version LIKE '%-milestone%'
    OR version LIKE '%.alpha%'
    OR version LIKE '%.beta%'
    OR version LIKE '%.rc%'
  );
