import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import * as schema from "@buildinternet/releases-core/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, "..", "src", "db", "migrations");

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export interface TestDatabase {
  db: TestDb;
  dbPath: string;
  cleanup: () => void;
}

/**
 * Create an isolated SQLite database for testing.
 * Runs all Drizzle migrations to match the current schema.
 * Call cleanup() when done to remove the temp directory.
 */
export function createTestDb(): TestDatabase {
  const tmpDir = mkdtempSync(join(tmpdir(), "releases-test-"));
  const dbPath = join(tmpDir, "test.db");
  const sqlite = new Database(dbPath);
  sqlite.run("PRAGMA journal_mode=WAL");
  sqlite.run("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite, { schema });

  migrate(db, { migrationsFolder });

  return {
    db,
    dbPath,
    cleanup: () => {
      sqlite.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * Delete all rows from every table in FK-safe order. Use inside beforeEach
 * so each test sees an empty DB without having to reason about dependencies.
 */
export function clearAllTables(db: TestDb): void {
  db.delete(schema.orgTags).run();
  db.delete(schema.productTags).run();
  db.delete(schema.releases).run();
  db.delete(schema.sources).run();
  db.delete(schema.orgAccounts).run();
  db.delete(schema.products).run();
  db.delete(schema.ignoredUrls).run();
  db.delete(schema.tags).run();
  db.delete(schema.domainAliases).run();
  db.delete(schema.organizations).run();
  db.delete(schema.blockedUrls).run();
}
