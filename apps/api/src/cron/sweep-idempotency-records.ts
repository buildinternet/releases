/**
 * Daily bounded cleanup for expired idempotency processing and replay records.
 *
 * Idempotency state remains available for its full 24-hour retention window.
 * This sweep removes at most one 500-record batch per run so cleanup cannot
 * monopolize D1 capacity when a backlog accumulates.
 */
import { count, lte } from "drizzle-orm";
import { idempotencyRecords } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js";
import { finalizeRunRow, insertRunningRow, reconcileStaleRunning } from "../db/cron-runs-dao.js";
import { sweepExpiredIdempotency } from "../lib/idempotency-store.js";

export const CRON_NAME = "sweep-idempotency-records";
export const SWEEP_LIMIT = 500;
export const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;

export type SweepIdempotencyRecordsEnv = {
  DB: D1Database;
  CRON_ENABLED?: string;
  /** TEST-ONLY: bypass createDb(env.DB) and use the provided instance directly. */
  // oxlint-disable-next-line no-explicit-any -- test seam, mirrors sibling sweeps
  _drizzleOverride?: any;
  /** TEST-ONLY: pin the cleanup cutoff and cron start timestamp. */
  _now?: Date;
  /** TEST-ONLY: pin the timestamp captured when the sweep completes. */
  _completedAt?: Date;
};

export async function sweepIdempotencyRecords(env: SweepIdempotencyRecordsEnv): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "sweep-idempotency-records", event: "cron-disabled" });
    return;
  }

  const db = env._drizzleOverride ?? createDb(env.DB);
  const now = env._now ?? new Date();
  const nowIso = now.toISOString();
  const completionIso = () => (env._completedAt ?? new Date()).toISOString();

  await reconcileStaleRunning(db, {
    cronName: CRON_NAME,
    now,
    thresholdMs: STALE_RUNNING_THRESHOLD_MS,
  });
  const runId = await insertRunningRow(db, { cronName: CRON_NAME, startedAt: nowIso });

  try {
    const deleted = await sweepExpiredIdempotency(db, { now: nowIso, limit: SWEEP_LIMIT });

    // A full batch means more expired records may remain past the limit; only
    // pay for a follow-up count in that case to flag the backlog.
    let backlogRemaining = 0;
    if (deleted === SWEEP_LIMIT) {
      const [{ value: remaining }] = await db
        .select({ value: count() })
        .from(idempotencyRecords)
        .where(lte(idempotencyRecords.expiresAt, nowIso));
      backlogRemaining = remaining;
    }

    const notes = `deleted=${deleted} limit=${SWEEP_LIMIT} backlogRemaining=${backlogRemaining}`;

    await finalizeRunRow(db, runId, {
      endedAt: completionIso(),
      status: "done",
      candidates: deleted + backlogRemaining,
      dispatched: deleted,
      skippedOverCap: backlogRemaining,
      dispatchErrors: 0,
      sessionsStarted: [],
      dispatchErrorDetail: [],
      notes,
    });

    logEvent("info", {
      component: "sweep-idempotency-records",
      event: "done",
      deleted,
      limit: SWEEP_LIMIT,
      backlogRemaining,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finalizeRunRow(db, runId, {
      endedAt: completionIso(),
      status: "aborted",
      abortReason: "config_missing",
      candidates: 0,
      dispatched: 0,
      skippedOverCap: 0,
      dispatchErrors: 1,
      sessionsStarted: [],
      dispatchErrorDetail: [{ orgSlug: "n/a", error: message }],
      notes: `idempotency sweep failed: ${message}`,
    });
    throw error;
  }
}
