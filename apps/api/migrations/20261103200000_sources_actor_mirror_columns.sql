-- Promote the SourceActor observability mirror out of `sources.metadata`
-- (`$.sourceActor.{managed,nextAlarmAt,lastAlarmAt}`) into real columns.
--
-- Every SourceActor alarm rewrote the whole metadata blob via json_set just to
-- update these three values, and the hourly poll-cron unmanaged sweep
-- json_extract'ed them out of every active source's blob. As columns, the
-- alarm write touches three small fields and the sweep compares plain values.
--
-- NULL actor_managed = the actor has never mirrored this source (same meaning
-- as an absent `$.sourceActor` key before).
ALTER TABLE sources ADD COLUMN actor_managed INTEGER;
ALTER TABLE sources ADD COLUMN actor_next_alarm_at TEXT;
ALTER TABLE sources ADD COLUMN actor_last_alarm_at TEXT;

-- Backfill from the JSON mirror, then drop the key from the blob. Rows with
-- malformed metadata are skipped (json_extract would throw on them).
UPDATE sources
SET
  actor_managed = json_extract(metadata, '$.sourceActor.managed'),
  actor_next_alarm_at = json_extract(metadata, '$.sourceActor.nextAlarmAt'),
  actor_last_alarm_at = json_extract(metadata, '$.sourceActor.lastAlarmAt'),
  metadata = json_remove(metadata, '$.sourceActor')
WHERE json_valid(metadata)
  AND json_type(metadata, '$.sourceActor') = 'object';

-- sources_active and sources_visible are `SELECT *` views frozen at create
-- time, so they must be dropped and recreated to surface the new columns
-- (same pattern as 20260703020000_add_source_last_drain_at.sql).
DROP VIEW IF EXISTS sources_visible;
DROP VIEW IF EXISTS sources_active;

CREATE VIEW IF NOT EXISTS sources_active AS
  SELECT * FROM sources WHERE deleted_at IS NULL;

CREATE VIEW IF NOT EXISTS sources_visible AS
  SELECT * FROM sources_active WHERE is_hidden = 0;
