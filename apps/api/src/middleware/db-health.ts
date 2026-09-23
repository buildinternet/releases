import type { MiddlewareHandler } from "hono";
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
 * Standardized error for the not-yet-migrated D1. The `database_not_initialized`
 * code is what the web transport (`web/src/lib/api.ts`) branches on to show the
 * setup steps, which ride in `details.setup`.
 */
function databaseNotInitializedError(): ServiceUnavailableError {
  return new ServiceUnavailableError(
    "The D1 database has not been set up yet. Run migrations first:",
    { code: "database_not_initialized", details: { setup: SETUP_STEPS } },
  );
}

let dbReady = false;

/**
 * Checks that D1 migrations have been applied before handling API requests.
 * Returns a clear setup message if the database tables are missing.
 */
export const dbHealthCheck: MiddlewareHandler<Env> = async (c, next) => {
  if (dbReady) return next();

  try {
    const row = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sources' LIMIT 1",
    ).first();

    if (!row) {
      return respondError(c, databaseNotInitializedError());
    }
    dbReady = true;
  } catch {
    return respondError(c, databaseNotInitializedError());
  }

  await next();
};
