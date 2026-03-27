import type { MiddlewareHandler } from "hono";

type Env = { Bindings: { DB: D1Database } };

/**
 * Checks that D1 migrations have been applied before handling API requests.
 * Returns a clear setup message if the database tables are missing.
 */
const setupResponse = {
  error: "database_not_initialized",
  message: "The D1 database has not been set up yet. Run migrations first:",
  setup: [
    "bun run db:migrate:local    # from the project root",
    "# then restart the dev server:",
    "bun run dev:api",
  ],
};

let dbReady = false;

export const dbHealthCheck: MiddlewareHandler<Env> = async (c, next) => {
  if (dbReady) return next();

  try {
    const row = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sources' LIMIT 1"
    ).first();

    if (!row) {
      return c.json(setupResponse, 503);
    }
    dbReady = true;
  } catch {
    return c.json(setupResponse, 503);
  }

  await next();
};
