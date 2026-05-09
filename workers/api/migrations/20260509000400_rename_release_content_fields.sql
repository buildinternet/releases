-- Rename the AI-generated release content columns so they line up with what
-- they actually are: alternate forms of title/summary, not a separate
-- "content" entity. Issue #860.
--
--   content_title       → title_generated
--   content_title_short → title_short
--   content_summary     → summary
--
-- SQLite ≥ 3.25 supports ALTER TABLE … RENAME COLUMN in place, preserving
-- data and rewriting references in trigger bodies, view definitions, and
-- index expressions. The releases_visible view expands `releases.*`, so it
-- picks up the rename automatically — no DROP/CREATE needed.
--
-- The releases_fts virtual table keeps its column literally named
-- `content_summary` so we don't have to rebuild + repopulate the index.
-- That's an internal FTS5 column name with no external query qualifier
-- usage in the codebase, so the misnomer is harmless. We drop and recreate
-- the AI/AD/AU triggers explicitly so the RHS reference (`new.summary`)
-- ends up unambiguous regardless of how the SQLite version handles the
-- automatic trigger-body rewrite.
DROP TRIGGER IF EXISTS releases_ai;
DROP TRIGGER IF EXISTS releases_ad;
DROP TRIGGER IF EXISTS releases_au;

ALTER TABLE releases RENAME COLUMN content_title TO title_generated;
ALTER TABLE releases RENAME COLUMN content_title_short TO title_short;
ALTER TABLE releases RENAME COLUMN content_summary TO summary;

CREATE TRIGGER IF NOT EXISTS releases_ai AFTER INSERT ON releases BEGIN
  INSERT INTO releases_fts(rowid, title, content, content_summary)
  VALUES (new.rowid, new.title, new.content, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS releases_ad AFTER DELETE ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, title, content, content_summary)
  VALUES ('delete', old.rowid, old.title, old.content, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS releases_au AFTER UPDATE ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, title, content, content_summary)
  VALUES ('delete', old.rowid, old.title, old.content, old.summary);
  INSERT INTO releases_fts(rowid, title, content, content_summary)
  VALUES (new.rowid, new.title, new.content, new.summary);
END;
