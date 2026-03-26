import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb } from "./connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, "migrations");

export function runMigrations() {
  const db = getDb();

  // Bridge: existing databases used PRAGMA user_version for migrations.
  // If that's set but __drizzle_migrations doesn't exist, seed the Drizzle
  // migration table so it skips the 0000 initial migration (already applied).
  bridgeLegacyMigrations(db);

  // Remove legacy CHECK constraint on sources.type — Drizzle doesn't use
  // CHECK constraints so we drop it to avoid manual work on new type additions.
  const droppedFts = removeLegacyCheckConstraint(db);

  // Run Drizzle-managed schema migrations
  migrate(db, { migrationsFolder });

  // FTS5 virtual tables and triggers are not managed by Drizzle (it doesn't
  // support SQLite virtual tables). We maintain them here with IF NOT EXISTS.
  setupFts(db);

  // If the CHECK removal dropped FTS, rebuild the index from existing data
  if (droppedFts) {
    db.run(sql`INSERT INTO releases_fts(releases_fts) VALUES('rebuild')`);
  }
}

/**
 * For databases created before Drizzle Kit migrations were adopted:
 * mark the 0000 baseline migration as already applied so `migrate()` won't
 * try to CREATE tables that already exist.
 */
function bridgeLegacyMigrations(db: ReturnType<typeof getDb>) {
  const versionResult = db.all<{ user_version: number }>(sql`PRAGMA user_version`);
  const userVersion = versionResult[0]?.user_version ?? 0;
  if (userVersion === 0) return; // Fresh database or already bridged

  const tables = db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`,
  );
  if (tables.length > 0) return; // Already using Drizzle migrations

  // Read the journal to get the 0000 migration's timestamp
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
  const baseline = journal.entries[0];
  if (!baseline) return;

  // Compute the hash the same way Drizzle does (SHA256 of the SQL file content)
  const sqlPath = join(migrationsFolder, `${baseline.tag}.sql`);
  const sqlContent = readFileSync(sqlPath, "utf-8");
  const hash = createHash("sha256").update(sqlContent).digest("hex");

  // Create the Drizzle migrations table and mark baseline as applied
  db.run(sql`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);
  // Guard against partial previous runs — only insert if not already present
  const existing = db.all<{ hash: string }>(
    sql`SELECT hash FROM __drizzle_migrations WHERE hash = ${hash}`,
  );
  if (existing.length === 0) {
    db.run(
      sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${hash}, ${baseline.when})`,
    );
  }

  // Clear user_version — Drizzle owns migration state now
  db.run(sql`PRAGMA user_version = 0`);
}

/**
 * Legacy databases had a CHECK(type IN (...)) constraint on sources.type.
 * Drizzle doesn't use CHECK constraints, so remove it by recreating the table.
 * This is idempotent — skips if no CHECK constraint is present.
 */
function removeLegacyCheckConstraint(db: ReturnType<typeof getDb>): boolean {
  const sourcesDdl = db.all<{ sql: string }>(
    sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='sources'`,
  );
  if (!sourcesDdl[0]?.sql?.includes("CHECK")) return false;

  db.run(sql`DROP TRIGGER IF EXISTS releases_ai`);
  db.run(sql`DROP TRIGGER IF EXISTS releases_ad`);
  db.run(sql`DROP TRIGGER IF EXISTS releases_au`);
  db.run(sql`DROP TABLE IF EXISTS releases_fts`);

  db.run(sql`CREATE TABLE sources_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    last_fetched_at TEXT,
    last_content_hash TEXT
  )`);
  db.run(sql`INSERT INTO sources_new SELECT id, name, slug, type, url, org_id, metadata, created_at, last_fetched_at, last_content_hash FROM sources`);
  db.run(sql`DROP TABLE sources`);
  db.run(sql`ALTER TABLE sources_new RENAME TO sources`);
  db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS sources_slug_unique ON sources(slug)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_sources_org ON sources(org_id)`);
  return true;
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
