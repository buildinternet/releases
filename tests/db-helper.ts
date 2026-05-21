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
 * apply` does in prod. After the squashed baseline this is usually one file;
 * any forward-delta migrations land in the same directory.
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

/**
 * The bun-sqlite drizzle adapter doesn't expose .batch (only drizzle-orm/d1
 * does). Patch it onto any drizzle handle that's missing it so prod code
 * calling db.batch(...) doesn't blow up under tests. Sequential await mirrors
 * D1's per-array ordering. Idempotent.
 */
export function ensureBatchShim<T>(db: T): T {
  const handle = db as unknown as { batch?: unknown };
  if (!handle.batch) {
    handle.batch = async (ops: ReadonlyArray<Promise<unknown>>) => {
      const out: unknown[] = [];
      for (const op of ops) {
        // oxlint-disable-next-line no-await-in-loop -- shim mirrors D1 batch ordering
        out.push(await op);
      }
      return out;
    };
  }
  return db;
}

export function createTestDb(): TestDatabase {
  const sqlite = Database.deserialize(getMigratedSnapshot());
  sqlite.run("PRAGMA foreign_keys=ON");
  const db = ensureBatchShim(drizzle(sqlite, { schema }));
  // Patch a D1-shaped `prepare` onto the drizzle handle so handlers that
  // wire `c.env.DB` to this object can both call `createDb(c.env.DB)` (drizzle
  // short-circuit via `.select`) and pass it to functions that talk to
  // `D1Database.prepare` directly (e.g. cursor-paginated feed queries) without
  // standing up a separate shim per test.
  const shim = makeD1Shim(sqlite);
  Object.assign(db as unknown as { prepare?: unknown }, {
    prepare: shim.prepare.bind(shim),
  });

  return {
    db,
    dbPath: ":memory:",
    cleanup: () => {
      sqlite.close();
    },
  };
}

/**
 * Build a seeded, D1-compatible database for tests that drive raw
 * `d1.prepare(...).bind(...).all()` query helpers (e.g. getLatestReleasesAcross)
 * rather than the drizzle query builder.
 *
 * Reuses createTestDb(): its handle is both a drizzle client (for the seeder's
 * `.insert(...)`) and a makeD1Shim-backed D1 object — createTestDb wires the
 * shim's `.prepare` onto it — so no separate Database/applyMigrations/makeD1Shim
 * dance is needed at the call site, and the migrated snapshot keeps setup cheap.
 */
export async function createSeededD1(seeder: (db: TestDb) => Promise<void>): Promise<D1Database> {
  const { db } = createTestDb();
  await seeder(db);
  return db as unknown as D1Database;
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
