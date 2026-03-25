import { sql } from "drizzle-orm";
import { getDb } from "./connection.js";


export function runMigrations() {
  const db = getDb();

  // Create tables if they don't exist
  db.run(sql`
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('github', 'scrape')),
      url TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      last_fetched_at TEXT
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      version TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_summary TEXT,
      url TEXT,
      content_hash TEXT,
      metadata TEXT DEFAULT '{}',
      published_at TEXT,
      fetched_at TEXT NOT NULL
    )
  `);

  // Indexes
  db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_releases_source_url ON releases(source_id, url)`);
  db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_releases_source_hash ON releases(source_id, content_hash)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_releases_source_published ON releases(source_id, published_at)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_releases_published ON releases(published_at)`);

  // FTS5 virtual table for full-text search
  db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS releases_fts USING fts5(
      title,
      content,
      content_summary,
      content='releases',
      content_rowid='id'
    )
  `);

  // Triggers to keep FTS in sync
  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS releases_ai AFTER INSERT ON releases BEGIN
      INSERT INTO releases_fts(rowid, title, content, content_summary)
      VALUES (new.id, new.title, new.content, new.content_summary);
    END
  `);

  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS releases_ad AFTER DELETE ON releases BEGIN
      INSERT INTO releases_fts(releases_fts, rowid, title, content, content_summary)
      VALUES ('delete', old.id, old.title, old.content, old.content_summary);
    END
  `);

  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS releases_au AFTER UPDATE ON releases BEGIN
      INSERT INTO releases_fts(releases_fts, rowid, title, content, content_summary)
      VALUES ('delete', old.id, old.title, old.content, old.content_summary);
      INSERT INTO releases_fts(rowid, title, content, content_summary)
      VALUES (new.id, new.title, new.content, new.content_summary);
    END
  `);
}
