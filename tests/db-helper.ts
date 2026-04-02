import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import * as schema from "../src/db/schema.js";
import { patchSchemaMetadataColumn } from "./db-patch.js";

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
  const tmpDir = mkdtempSync(join(tmpdir(), "released-test-"));
  const dbPath = join(tmpDir, "test.db");
  const sqlite = new Database(dbPath);
  sqlite.run("PRAGMA journal_mode=WAL");
  sqlite.run("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite, { schema });

  migrate(db, { migrationsFolder });

  patchSchemaMetadataColumn(sqlite);

  return {
    db,
    dbPath,
    cleanup: () => {
      sqlite.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
