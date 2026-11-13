import { type AnyD1Database, drizzle } from "drizzle-orm/d1";
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

// ── D1 read replication (Sessions API) ──────────────────────────────────────
//
// With read replication enabled on the database, only queries issued through a
// `withSession()` handle may be served by a replica; plain-binding queries keep
// going to the primary. So the plain binding IS the primary path, and opting a
// request into replicas is a matter of swapping `env.DB` for a session handle.
// Writes inside a session are still routed to the primary, and a session is
// sequentially consistent (a read after its own write sees that write).
// See docs/architecture/storage-portability.md → Read replication.

/** `withSession()` start constraint: a replica-eligible start, a primary start, or a bookmark. */
export type D1SessionConstraint = "first-unconstrained" | "first-primary" | (string & {});

/** The slice of a D1 session handle we rely on (drizzle only calls prepare/batch). */
export interface D1SessionLike {
  prepare: (...args: never[]) => unknown;
  batch: (...args: never[]) => unknown;
  getBookmark: () => string | null;
}

interface D1WithSessions {
  withSession: (constraint?: string) => D1SessionLike;
}

const PRIMARY_BINDING = Symbol.for("releases.d1.primaryBinding");

/** True when the binding supports the Sessions API (prod/miniflare D1, not test shims). */
export function supportsD1Sessions(db: unknown): db is D1WithSessions {
  return (
    db != null &&
    typeof db === "object" &&
    typeof (db as { withSession?: unknown }).withSession === "function"
  );
}

/**
 * Open a Sessions-API handle on a raw D1 binding. Returns `null` when the binding
 * has no `withSession` (test shims, drizzle handles) so callers keep the plain
 * binding. The handle remembers its source binding for {@link primaryD1Binding}.
 */
export function openD1Session(db: unknown, constraint: D1SessionConstraint): D1SessionLike | null {
  if (!supportsD1Sessions(db)) return null;
  const session = db.withSession(constraint);
  Object.defineProperty(session, PRIMARY_BINDING, { value: db, enumerable: false });
  return session;
}

/**
 * The underlying binding behind a session handle (or the value itself when it
 * isn't one). For consumers that must stay on the primary even inside a
 * replica-eligible request, or that key caches on the binding's identity — the
 * Better Auth instance cache does both.
 */
export function primaryD1Binding<T>(db: T): T {
  if (db != null && typeof db === "object") {
    const raw = (db as Record<symbol, unknown>)[PRIMARY_BINDING];
    if (raw != null) return raw as T;
  }
  return db;
}
