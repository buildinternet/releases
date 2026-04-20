import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import * as schema from "@buildinternet/releases-core/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "workers", "api", "migrations");

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export interface TestDatabase {
  db: TestDb;
  dbPath: string;
  cleanup: () => void;
}

/**
 * Apply every .sql file under workers/api/migrations/ in sorted filename
 * order to the given sqlite database. Matches what `wrangler d1 migrations
 * apply` does in prod.
 */
export function applyMigrations(sqlite: Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    sqlite.run(sql);
  }
}

export function createTestDb(): TestDatabase {
  const tmpDir = mkdtempSync(join(tmpdir(), "releases-test-"));
  const dbPath = join(tmpDir, "test.db");
  const sqlite = new Database(dbPath);
  sqlite.run("PRAGMA journal_mode=WAL");
  sqlite.run("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite, { schema });

  applyMigrations(sqlite);

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
