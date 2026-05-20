import { drizzle } from "drizzle-orm/d1";
import * as schema from "@buildinternet/releases-core/schema";

export type D1Db = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(dbOrD1: D1Database | D1Db): D1Db {
  // Allow tests to pass a pre-built drizzle handle (e.g. bun-sqlite) so the
  // query builder reads against a real fixture — the makeD1Shim path can't
  // serve drizzle-query-builder reads. Mirrors workers/api/src/db.ts.
  if (dbOrD1 && typeof (dbOrD1 as { select?: unknown }).select === "function") {
    return dbOrD1 as D1Db;
  }
  return drizzle(dbOrD1 as D1Database, { schema });
}
