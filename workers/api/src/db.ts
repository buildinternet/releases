import { drizzle } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "@buildinternet/releases-core/schema";

export type D1Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * A drizzle SQLite handle widened across all four generic slots. `D1Db` (the prod
 * D1 handle) is a strict subtype; the widening is needed by query helpers that
 * also run against the `bun:sqlite`-backed test handle (a different result-kind).
 * Shared here so callers don't each re-paste the `any`-widened alias + suppression.
 */
// oxlint-disable-next-line no-explicit-any -- matches D1Db in prod, BunSQLite in tests
export type AnyDb = BaseSQLiteDatabase<any, any, any, any>;

export function createDb(dbOrD1: D1Database | D1Db): D1Db {
  // Allow tests to pass a pre-built drizzle handle (e.g. bun-sqlite).
  if (dbOrD1 && typeof (dbOrD1 as { select?: unknown }).select === "function") {
    return dbOrD1 as D1Db;
  }
  return drizzle(dbOrD1 as D1Database, { schema });
}
