import { and, eq, lt } from "drizzle-orm";
import { cronRuns } from "./schema-cron.js";
import { newCronRunId } from "@buildinternet/releases-core/id";

/** Cap on JSON arrays stored in dispatch_error_detail / sessions_started. */
export const CRON_RUNS_JSON_ARRAY_CAP = 20;

export async function insertRunningRow(
  db: any,
  params: { cronName: string; startedAt: string },
): Promise<string> {
  const id = newCronRunId();
  await db.insert(cronRuns).values({
    id,
    cronName: params.cronName,
    startedAt: params.startedAt,
    status: "running" as const,
  });
  return id;
}

export type FinalizeRunParams = {
  endedAt: string;
  status: "done" | "degraded" | "dispatch_failed" | "aborted";
  candidates: number;
  dispatched: number;
  skippedOverCap: number;
  dispatchErrors: number;
  sessionsStarted: string[];
  dispatchErrorDetail: Array<{ orgSlug: string; error: string }>;
  abortReason?: "anthropic_auth" | "anthropic_credits" | "stale_running" | "cron_disabled" | "config_missing";
  notes: string | null;
};

export async function finalizeRunRow(
  db: any,
  id: string,
  params: FinalizeRunParams,
): Promise<void> {
  // Compute duration from the running row's startedAt to avoid trusting callers.
  const rows = await db.select({ startedAt: cronRuns.startedAt })
    .from(cronRuns)
    .where(eq(cronRuns.id, id));
  const existing = rows[0];
  const durationMs = existing
    ? new Date(params.endedAt).getTime() - new Date(existing.startedAt).getTime()
    : null;

  const sessionsArr = params.sessionsStarted.slice(0, CRON_RUNS_JSON_ARRAY_CAP);
  const errorsArr = params.dispatchErrorDetail.slice(0, CRON_RUNS_JSON_ARRAY_CAP);

  await db.update(cronRuns).set({
    endedAt: params.endedAt,
    durationMs,
    status: params.status,
    candidates: params.candidates,
    dispatched: params.dispatched,
    skippedOverCap: params.skippedOverCap,
    dispatchErrors: params.dispatchErrors,
    sessionsStarted: sessionsArr.length > 0 ? JSON.stringify(sessionsArr) : null,
    dispatchErrorDetail: errorsArr.length > 0 ? JSON.stringify(errorsArr) : null,
    abortReason: params.abortReason ?? null,
    notes: params.notes,
  }).where(eq(cronRuns.id, id));
}

export async function reconcileStaleRunning(
  db: any,
  params: { cronName: string; now: Date; thresholdMs: number },
): Promise<number> {
  const cutoff = new Date(params.now.getTime() - params.thresholdMs).toISOString();
  const result = await db.update(cronRuns).set({
    status: "aborted",
    abortReason: "stale_running",
    endedAt: params.now.toISOString(),
    notes: "reconciled by next sweep",
  }).where(and(
    eq(cronRuns.cronName, params.cronName),
    eq(cronRuns.status, "running"),
    lt(cronRuns.startedAt, cutoff),
  )).returning({ id: cronRuns.id });
  return Array.isArray(result) ? result.length : 0;
}
