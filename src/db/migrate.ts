import { sql } from "drizzle-orm";
import { getDb } from "./connection.js";


export function runMigrations() {
  const db = getDb();

  // Schema versioning via PRAGMA user_version
  const { user_version } = db.get<{ user_version: number }>(sql`PRAGMA user_version`) ?? { user_version: 0 };

  // v0 → v1: migrate from integer autoincrement IDs to text nanoid IDs
  if (user_version < 1) {
    db.run(sql`DROP TABLE IF EXISTS releases_fts`);
    db.run(sql`DROP TRIGGER IF EXISTS releases_ai`);
    db.run(sql`DROP TRIGGER IF EXISTS releases_ad`);
    db.run(sql`DROP TRIGGER IF EXISTS releases_au`);
    db.run(sql`DROP TABLE IF EXISTS releases`);
    db.run(sql`DROP TABLE IF EXISTS sources`);
    db.run(sql`PRAGMA user_version = 1`);
  }

  // Create tables if they don't exist
  db.run(sql`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('github', 'scrape')),
      url TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      last_fetched_at TEXT,
      last_content_hash TEXT
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS releases (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
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

  // Usage log table (keeps integer IDs — internal-only, no cross-system concern)
  db.run(sql`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      source_slug TEXT,
      release_count INTEGER,
      created_at TEXT NOT NULL
    )
  `);

  // FTS5 virtual table for full-text search
  // Uses SQLite's implicit rowid on the releases table
  db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS releases_fts USING fts5(
      title,
      content,
      content_summary,
      content='releases',
      content_rowid='rowid'
    )
  `);

  // Triggers to keep FTS in sync (using implicit rowid)
  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS releases_ai AFTER INSERT ON releases BEGIN
      INSERT INTO releases_fts(rowid, title, content, content_summary)
      VALUES (new.rowid, new.title, new.content, new.content_summary);
    END
  `);

  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS releases_ad AFTER DELETE ON releases BEGIN
      INSERT INTO releases_fts(releases_fts, rowid, title, content, content_summary)
      VALUES ('delete', old.rowid, old.title, old.content, old.content_summary);
    END
  `);

  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS releases_au AFTER UPDATE ON releases BEGIN
      INSERT INTO releases_fts(releases_fts, rowid, title, content, content_summary)
      VALUES ('delete', old.rowid, old.title, old.content, old.content_summary);
      INSERT INTO releases_fts(rowid, title, content, content_summary)
      VALUES (new.rowid, new.title, new.content, new.content_summary);
    END
  `);
}
