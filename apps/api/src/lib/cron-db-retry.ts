import { classifyDbError, dbErrorLogFields } from "@releases/lib/db-errors";
import { logEvent } from "@releases/lib/log-event";

/**
 * Drizzle wraps driver errors as `Failed query: <sql> params: …` and keeps the
 * D1 message (overloaded / timeout / no such column) on `.cause`. Append it so
 * a crash alert says why the query failed, not just which query.
 */
export function crashMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const db = classifyDbError(err);
  if (db && !message.includes(db.message)) return `${db.message} [${db.code}]\n\n${message}`;
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  if (cause instanceof Error && cause.message && !message.includes(cause.message)) {
    return `${cause.message}\n\n${message}`;
  }
  return message;
}

const TRANSIENT_DB_RETRY_DELAY_MS = 12_000;

/**
 * Run a cron preflight read, retrying once on a transient D1 error. D1's
 * overload limit is a 10-second window, so the single retry waits past it
 * rather than hammering the database. A hard error (bad SQL, missing column)
 * rethrows immediately.
 */
export async function withTransientDbRetry<T>(
  label: string,
  fn: () => Promise<T>,
  delayMs = TRANSIENT_DB_RETRY_DELAY_MS,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const db = classifyDbError(err);
    if (!db?.transient) throw err;
    logEvent("warn", {
      component: "cron",
      event: "transient-db-retry",
      query: label,
      ...dbErrorLogFields(err),
    });
    await new Promise((r) => setTimeout(r, delayMs));
    return fn();
  }
}
