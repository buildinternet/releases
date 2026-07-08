import { type AnyD1Database, drizzle } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "@buildinternet/releases-core/schema";

export type D1Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Max bound parameters to place in a single `IN (...)` list against the
 * relational backend. D1's hard ceiling is 100 bound parameters per prepared
 * statement; 90 leaves headroom for the other binds a query carries alongside
 * the `IN` list (FTS match text, `LIMIT`, date bounds, org scope, …).
 *
 * This is a backend *capability*, not a magic number: a higher-limit backend
 * (Postgres allows tens of thousands) can raise it in this one place. Callers
 * that may exceed it chunk their ID list and union the results (see
 * `getOrgSparklines` in `workers/api/src/queries/orgs.ts`).
 */
export const D1_MAX_IN_PARAMS = 90;

/**
 * A drizzle SQLite handle widened across all four generic slots. `D1Db` (the prod
 * D1 handle) is a strict subtype; the widening is needed by query helpers that
 * also run against the `bun:sqlite`-backed test handle (a different result-kind).
 * Shared here so callers don't each re-paste the `any`-widened alias + suppression.
 */
// oxlint-disable-next-line no-explicit-any -- matches D1Db in prod, BunSQLite in tests
export type AnyDb = BaseSQLiteDatabase<any, any, any, any>;

/**
 * The single DB-construction seam for the whole monorepo. Every worker and
 * package builds its Drizzle handle here so a future backend swap (e.g. a
 * Postgres branch on `drizzle-orm/postgres-js`) is one edit, not 3–4.
 *
 * Passes a pre-built drizzle handle straight through (tests inject a
 * `bun:sqlite`-backed handle so the query builder reads a real fixture — the
 * makeD1Shim path can't serve drizzle-query-builder reads), otherwise wraps a
 * raw `D1Database` binding with `{ schema }` attached.
 */
export function createDb(dbOrD1: AnyD1Database | D1Db): D1Db {
  if (dbOrD1 && typeof (dbOrD1 as { select?: unknown }).select === "function") {
    return dbOrD1 as D1Db;
  }
  return drizzle(dbOrD1 as AnyD1Database, { schema });
}
