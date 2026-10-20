import type { MiddlewareHandler } from "hono";
import { logEvent } from "@releases/lib/log-event";
import { classifyDbError } from "@releases/lib/db-errors";
import { respondError } from "../lib/error-response.js";
import { ServiceUnavailableError } from "@releases/lib/releases-error";

type Env = { Bindings: { DB: D1Database } };

/** Setup steps surfaced to the operator (web transport reads `details.setup`). */
const SETUP_STEPS = [
  "bun run db:migrate:local    # from the project root",
  "# then restart the dev server:",
  "bun run dev:api",
];

/**
 * Hint for clients when D1 blips (nightly export, overload, dropped connection).
 * Short enough to retry past a brief export pause, long enough to avoid a stampede.
 */
const DB_HEALTH_RETRY_AFTER_SECONDS = 10;

/**
 * Standardized error for the not-yet-migrated D1. The `database_not_initialized`
 * code is what the web transport (`apps/web/src/lib/api.ts`) branches on to show the
 * setup steps, which ride in `details.setup`.
 */
function databaseNotInitializedError(): ServiceUnavailableError {
  return new ServiceUnavailableError(
    "The D1 database has not been set up yet. Run migrations first:",
    { code: "database_not_initialized", details: { setup: SETUP_STEPS } },
  );
}

let dbReady = false;

function errorChainText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  for (let i = 0; i < 8 && cur instanceof Error && !seen.has(cur); i++) {
    parts.push(cur.message);
    seen.add(cur);
    cur = cur.cause;
  }
  return parts.join("\n");
}

/** A genuinely missing table — the only case that should ask the operator to migrate. */
function isMissingTableError(err: unknown): boolean {
  return /no such table/i.test(errorChainText(err));
}

function probeSourcesTable(db: D1Database): Promise<unknown> {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sources' LIMIT 1")
    .first();
}

/**
 * One retry for known transient D1 errors (`classifyDbError`). A missing table
 * is not retried — it will fail the same way immediately.
 */
async function probeSourcesTableWithRetry(db: D1Database): Promise<unknown> {
  try {
    return await probeSourcesTable(db);
  } catch (err) {
    if (isMissingTableError(err) || classifyDbError(err)?.transient !== true) throw err;
    return await probeSourcesTable(db);
  }
}

/**
 * Checks that D1 migrations have been applied before handling API requests.
 * A missing `sources` table returns the setup message. Any other probe failure
 * (overload during the nightly export, "Network connection lost", storage
 * reset) is a retryable 503 and does not latch `dbReady`.
 */
export const dbHealthCheck: MiddlewareHandler<Env> = async (c, next) => {
  if (dbReady) return next();

  try {
    const row = await probeSourcesTableWithRetry(c.env.DB);
    if (!row) return respondError(c, databaseNotInitializedError());
    dbReady = true;
  } catch (err) {
    if (isMissingTableError(err)) {
      logEvent("error", { component: "api", event: "db_health_check_failed", err });
      return respondError(c, databaseNotInitializedError());
    }

    const classified = classifyDbError(err);
    logEvent("warn", {
      component: "api",
      event: "db_health_check_failed",
      err,
      transient: true,
      ...(classified
        ? {
            causeCode: classified.code,
            causeMessage: classified.message,
            causeTransient: classified.transient,
          }
        : {}),
    });
    const res = respondError(
      c,
      new ServiceUnavailableError("The database is temporarily unavailable."),
    );
    res.headers.set("Retry-After", String(DB_HEALTH_RETRY_AFTER_SECONDS));
    return res;
  }

  await next();
};
