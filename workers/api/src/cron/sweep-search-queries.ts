/**
 * Nightly retention sweep for the `search_queries` table (#575).
 *
 * Deletes rows older than `SEARCH_QUERY_RETENTION_DAYS` (default 90).
 * Query text is user-typed and may include accidentally-pasted secrets;
 * indefinite retention widens the exposure window unnecessarily.
 *
 * Runs at 05:00 UTC daily. Emits a `cron_runs` row via the standard
 * `insertRunningRow` / `finalizeRunRow` pattern used by other sweeps.
 */

import { lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { searchQueries } from "@buildinternet/releases-core/schema";
import { finalizeRunRow, insertRunningRow, reconcileStaleRunning } from "../db/cron-runs-dao.js";

export const CRON_NAME = "sweep-search-queries";
export const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;
export const DEFAULT_RETENTION_DAYS = 90;

export type SweepSearchQueriesEnv = {
  DB: D1Database;
  CRON_ENABLED?: string;
  SEARCH_QUERY_RETENTION_DAYS?: string;
  /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
  _drizzleOverride?: any;
};

function parseRetentionDays(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

export async function sweepSearchQueries(env: SweepSearchQueriesEnv): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    console.log("[sweep-search-queries] CRON_ENABLED=false; skipping");
    return;
  }

  const db = env._drizzleOverride ?? drizzle(env.DB);
  const now = new Date();
  const retentionDays = parseRetentionDays(env.SEARCH_QUERY_RETENTION_DAYS);

  // timestamp is stored as ms since epoch (Date.now())
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  await reconcileStaleRunning(db, {
    cronName: CRON_NAME,
    now,
    thresholdMs: STALE_RUNNING_THRESHOLD_MS,
  });

  const runId = await insertRunningRow(db, { cronName: CRON_NAME, startedAt: now.toISOString() });

  let deleted = 0;
  try {
    const result = await db
      .delete(searchQueries)
      .where(lt(searchQueries.timestamp, cutoffMs))
      .returning({ id: searchQueries.id });
    deleted = Array.isArray(result) ? result.length : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finalizeRunRow(db, runId, {
      endedAt: new Date().toISOString(),
      status: "aborted",
      abortReason: "config_missing",
      candidates: 0,
      dispatched: 0,
      skippedOverCap: 0,
      dispatchErrors: 1,
      sessionsStarted: [],
      dispatchErrorDetail: [{ orgSlug: "n/a", error: message }],
      notes: `delete failed: ${message}`,
    });
    throw err;
  }

  const notes =
    deleted === 0
      ? `no rows older than ${retentionDays}d`
      : `deleted=${deleted} rows older than ${retentionDays}d`;

  await finalizeRunRow(db, runId, {
    endedAt: new Date().toISOString(),
    status: "done",
    candidates: deleted,
    dispatched: deleted,
    skippedOverCap: 0,
    dispatchErrors: 0,
    sessionsStarted: [],
    dispatchErrorDetail: [],
    notes,
  });

  console.log(`[sweep-search-queries] done: ${notes}`);
}
