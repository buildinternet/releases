-- Rename the releases_fts virtual-table column from `content_summary` to
-- `summary` to match the base table column rename done in migration
-- 20260509000400 (issue #860 / #865).
--
-- SQLite's RENAME COLUMN does not propagate into FTS5 virtual tables, so we
-- must drop the entire index, recreate it with the corrected column name, and
-- reindex from the base table in one statement. The migration 20260509000400
-- already updated the trigger bodies to reference `new.summary` / `old.summary`
-- on the base table side; here we bring the FTS5 column name into alignment.
--
-- Reindex path: INSERT INTO releases_fts ... SELECT ... FROM releases drives a
-- full rebuild in a single D1 statement — no per-row cursor needed.
--
-- Triggers are rebuilt at the end so their column lists are consistent with
-- the recreated virtual table.

-- 1. Drop the existing triggers so we can safely drop the FTS table.
DROP TRIGGER IF EXISTS releases_ai;
DROP TRIGGER IF EXISTS releases_ad;
DROP TRIGGER IF EXISTS releases_au;

-- 2. Drop the FTS5 virtual table (all FTS data is derived; we repopulate below).
DROP TABLE IF EXISTS releases_fts;

-- 3. Recreate the FTS5 virtual table with `summary` instead of `content_summary`.
CREATE VIRTUAL TABLE releases_fts USING fts5(
  title,
  summary,
  content,
  content='releases',
  content_rowid='rowid'
);

-- 4. Reindex: populate from the base table in one pass.
INSERT INTO releases_fts(rowid, title, summary, content)
  SELECT rowid, title, summary, content FROM releases;

-- 5. Recreate the three DML triggers using the new column name.
CREATE TRIGGER IF NOT EXISTS releases_ai AFTER INSERT ON releases BEGIN
  INSERT INTO releases_fts(rowid, title, summary, content)
  VALUES (new.rowid, new.title, new.summary, new.content);
END;

CREATE TRIGGER IF NOT EXISTS releases_ad AFTER DELETE ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, title, summary, content)
  VALUES ('delete', old.rowid, old.title, old.summary, old.content);
END;

CREATE TRIGGER IF NOT EXISTS releases_au AFTER UPDATE ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, title, summary, content)
  VALUES ('delete', old.rowid, old.title, old.summary, old.content);
  INSERT INTO releases_fts(rowid, title, summary, content)
  VALUES (new.rowid, new.title, new.summary, new.content);
END;
