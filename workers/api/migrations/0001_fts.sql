-- 0001_fts.sql
CREATE VIRTUAL TABLE IF NOT EXISTS releases_fts USING fts5(
  title,
  content,
  content_summary,
  content='releases',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS releases_ai AFTER INSERT ON releases BEGIN
  INSERT INTO releases_fts(rowid, title, content, content_summary)
  VALUES (new.rowid, new.title, new.content, new.content_summary);
END;

CREATE TRIGGER IF NOT EXISTS releases_ad AFTER DELETE ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, title, content, content_summary)
  VALUES ('delete', old.rowid, old.title, old.content, old.content_summary);
END;

CREATE TRIGGER IF NOT EXISTS releases_au AFTER UPDATE ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, title, content, content_summary)
  VALUES ('delete', old.rowid, old.title, old.content, old.content_summary);
  INSERT INTO releases_fts(rowid, title, content, content_summary)
  VALUES (new.rowid, new.title, new.content, new.content_summary);
END;
