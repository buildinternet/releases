import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb } from "./connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, "migrations");

export function runMigrations() {
  const db = getDb();

  // Run Drizzle-managed schema migrations
  migrate(db, { migrationsFolder });

  // FTS5 virtual tables and triggers are not managed by Drizzle (it doesn't
  // support SQLite virtual tables). We maintain them here with IF NOT EXISTS.
  setupFts(db);
}

/** FTS5 virtual table + sync triggers (not managed by Drizzle) */
function setupFts(db: ReturnType<typeof getDb>) {
  db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS releases_fts USING fts5(
      title,
      content,
      content_summary,
      content='releases',
      content_rowid='rowid'
    )
  `);

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
