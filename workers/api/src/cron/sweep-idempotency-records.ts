/**
 * Daily bounded cleanup for expired idempotency processing and replay records.
 *
 * Idempotency state remains available for its full 24-hour retention window.
 * This sweep removes at most one 500-record batch per run so cleanup cannot
 * monopolize D1 capacity when a backlog accumulates.
 */
import { count, lte } from "drizzle-orm";
import { idempotencyGuards } from "@buildinternet/releases-core/schema";
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
  /** TEST-ONLY: pin the cleanup cutoff and cron timestamps. */
  _now?: Date;
};

export async function sweepIdempotencyRecords(env: SweepIdempotencyRecordsEnv): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "sweep-idempotency-records", event: "cron-disabled" });
    return;
  }

  const db = env._drizzleOverride ?? createDb(env.DB);
  const now = env._now ?? new Date();
  const nowIso = now.toISOString();

  await reconcileStaleRunning(db, {
    cronName: CRON_NAME,
    now,
    thresholdMs: STALE_RUNNING_THRESHOLD_MS,
  });
  const runId = await insertRunningRow(db, { cronName: CRON_NAME, startedAt: nowIso });

  try {
    const [{ value: candidates }] = await db
      .select({ value: count() })
      .from(idempotencyGuards)
      .where(lte(idempotencyGuards.expiresAt, nowIso));
    const deleted = await sweepExpiredIdempotency(db, { now: nowIso, limit: SWEEP_LIMIT });
    const notes = `candidates=${candidates} deleted=${deleted} limit=${SWEEP_LIMIT}`;

    await finalizeRunRow(db, runId, {
      endedAt: nowIso,
      status: "done",
      candidates,
      dispatched: deleted,
      skippedOverCap: Math.max(0, candidates - deleted),
      dispatchErrors: 0,
      sessionsStarted: [],
      dispatchErrorDetail: [],
      notes,
    });

    logEvent("info", {
      component: "sweep-idempotency-records",
      event: "done",
      candidates,
      deleted,
      limit: SWEEP_LIMIT,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finalizeRunRow(db, runId, {
      endedAt: nowIso,
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
