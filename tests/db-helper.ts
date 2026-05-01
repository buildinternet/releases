import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readdirSync, readFileSync } from "fs";
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

/**
 * Snapshot of a fully-migrated empty SQLite, captured once per process. Each
 * createTestDb call deserialises this buffer instead of re-reading and
 * re-executing every migration file — the per-test cost drops from ~hundreds
 * of ms (and occasional 5s hook timeouts) to a single buffer copy.
 */
let migratedSnapshot: Uint8Array | null = null;

function getMigratedSnapshot(): Uint8Array {
  if (migratedSnapshot) return migratedSnapshot;
  const seed = new Database(":memory:");
  seed.run("PRAGMA foreign_keys=ON");
  applyMigrations(seed);
  migratedSnapshot = seed.serialize();
  seed.close();
  return migratedSnapshot;
}

export function createTestDb(): TestDatabase {
  const sqlite = Database.deserialize(getMigratedSnapshot());
  sqlite.run("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite, { schema });

  return {
    db,
    dbPath: ":memory:",
    cleanup: () => {
      sqlite.close();
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
