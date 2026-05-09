import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readdirSync, readFileSync } from "fs";
import * as schema from "@buildinternet/releases-core/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "workers", "api", "migrations");
const SCRIPT_MIGRATIONS_DIR = join(__dirname, "..", "scripts", "migrations");

// #690 Phase C rebuild lives outside workers/api/migrations because the D1
// migration system can't run table rebuilds (see the marker file
// 20260504000400_per_org_slug_cutover.sql). Tests still need to apply it
// so the bun:sqlite fixture matches prod's post-rebuild schema.
const SCRIPT_REBUILDS: Array<{ file: string; afterMigration: string }> = [
  {
    file: "690-phase-c-rebuild.sql",
    afterMigration: "20260504000400_per_org_slug_cutover.sql",
  },
];

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export interface TestDatabase {
  db: TestDb;
  dbPath: string;
  cleanup: () => void;
}

/**
 * Apply every .sql file under workers/api/migrations/ in sorted filename
 * order to the given sqlite database. Matches what `wrangler d1 migrations
 * apply` does in prod, plus interleaves any scripts/migrations/*.sql
 * rebuilds at the point in the timeline where they were applied to prod.
 */
export function applyMigrations(sqlite: Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    // Skip comment-only/empty marker files. Wrangler's migrations apply is
    // fine with them; bun:sqlite throws "no valid SQL statement".
    if (stripComments(sql).trim().length > 0) {
      sqlite.run(sql);
    }
    for (const rebuild of SCRIPT_REBUILDS) {
      if (rebuild.afterMigration === f) {
        const rebuildSql = readFileSync(join(SCRIPT_MIGRATIONS_DIR, rebuild.file), "utf8");
        sqlite.run(rebuildSql);
      }
    }
  }
}

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
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
 * Build a minimal D1Database shim over a bun:sqlite Database so code that
 * calls into raw `d1.prepare(...).bind(...).all()` (or the drizzle D1
 * adapter) can run against an in-process SQLite fixture. Errors on
 * `.all/.run/.first` are swallowed and surface as empty results so tests
 * tolerate missing fixtures (e.g. DDL-only tables not seeded).
 */
export function makeD1Shim(sqlite: Database): D1Database {
  const sqliteRunner = sqlite;
  return {
    prepare(query: string) {
      return {
        bind(...args: unknown[]) {
          const stmt = sqliteRunner.prepare(query);
          return {
            async run() {
              try {
                stmt.run(...(args as Parameters<typeof stmt.run>));
              } catch {
                // ignore — some DDL-only tables may not exist in the fixture
              }
              return { results: [], success: true, meta: {} };
            },
            async all() {
              try {
                const results = stmt.all(...(args as Parameters<typeof stmt.all>));
                return { results, success: true, meta: {} };
              } catch {
                return { results: [], success: false, meta: {} };
              }
            },
            async first<T = unknown>(): Promise<T | null> {
              try {
                const result = stmt.get(...(args as Parameters<typeof stmt.get>));
                return (result as T) ?? null;
              } catch {
                return null;
              }
            },
            async raw<T = unknown[]>(): Promise<T[]> {
              return [];
            },
          };
        },
        async run() {
          return { results: [], success: true, meta: {} };
        },
        async all() {
          return { results: [], success: true, meta: {} };
        },
        async first() {
          return null;
        },
        async raw() {
          return [];
        },
      } as unknown as D1PreparedStatement;
    },
    async batch() {
      return [];
    },
  } as unknown as D1Database;
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
  // collection_members cascades from collections; clear collections after the
  // join is gone to keep deletion order explicit. The seed migration creates
  // `frontier-ai-labs`, so leaving it in would leak into every test.
  db.delete(schema.collectionMembers).run();
  db.delete(schema.collections).run();
  db.delete(schema.organizations).run();
  db.delete(schema.blockedUrls).run();
}
