/**
 * Persistence helpers for the batch_runs table. Used by callers that submit
 * Anthropic Message Batches (script, future BatchSummarizeWorkflow) so
 * the SQL stays in one place and callers only deal with typed domain objects.
 *
 * Three lifecycle calls:
 *   1. recordBatchSubmit — insert at submission (status: submitted)
 *   2. recordBatchProgress — update in-flight counts on each poll tick (status: in_progress)
 *   3. recordBatchFinalize — stamp ended_at + final counts + actual cost (status: ended | failed)
 */

import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
// Relative import instead of the package alias so this file resolves correctly
// in both production (workers/api picks up packages/core via workspace) and in
// bun test runs where the workspace symlink points to the main-branch
// packages/core (which may not yet have the new exports from a worktree).
import { batchRuns } from "../../core/src/schema.js";

/** Minimal drizzle DB type accepted by all helpers. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle generic param isn't exposed uniformly across runtimes
type AnyDb = DrizzleD1Database<any>;

// ── recordBatchSubmit ────────────────────────────────────────────────────────

/** Values allowed in the batch_runs.caller column. */
export type BatchCaller = "script" | "workflow" | "admin";

/** Terminal status values for a batch run. */
export type TerminalBatchStatus = "ended" | "failed";

export interface BatchSubmitFields {
  /** Anthropic batch ID returned by submitBatch (e.g. "msgbatch_…"). */
  anthropicBatchId: string;
  /** Who is submitting: 'script' | 'workflow' | 'admin'. */
  caller: BatchCaller;
  /** Model slug (e.g. "claude-haiku-4-5-20251001"). */
  model: string;
  /** Total number of requests in this batch. */
  requestCountTotal: number;
  /** Pre-submission cost estimate from estimateCost(). */
  estCostUsd?: number | null;
  /** Free-form caller context (e.g. { orgs: [...], since_days: N }). */
  callerContext?: Record<string, unknown> | null;
}

/**
 * Insert a new batch_runs row at submission time. Status starts as "submitted".
 * Returns the generated row id (bat_…).
 */
export async function recordBatchSubmit(db: AnyDb, fields: BatchSubmitFields): Promise<string> {
  const row = {
    anthropicBatchId: fields.anthropicBatchId,
    caller: fields.caller,
    model: fields.model,
    status: "submitted" as const,
    requestCountTotal: fields.requestCountTotal,
    estCostUsd: fields.estCostUsd ?? null,
    callerContext: fields.callerContext ? JSON.stringify(fields.callerContext) : null,
  };
  const [inserted] = await db.insert(batchRuns).values(row).returning({ id: batchRuns.id });
  return inserted!.id;
}

// ── recordBatchProgress ──────────────────────────────────────────────────────

export interface BatchProgressCounts {
  succeeded: number;
  errored: number;
  expired: number;
  canceled: number;
}

/**
 * Update in-flight request counts for a batch. Sets status to "in_progress".
 * Called on each poll tick inside pollBatch's onPoll callback.
 */
export async function recordBatchProgress(
  db: AnyDb,
  anthropicId: string,
  counts: BatchProgressCounts,
): Promise<void> {
  await db
    .update(batchRuns)
    .set({
      status: "in_progress",
      requestCountSucceeded: counts.succeeded,
      requestCountErrored: counts.errored,
      requestCountExpired: counts.expired,
      requestCountCanceled: counts.canceled,
    })
    .where(eq(batchRuns.anthropicBatchId, anthropicId));
}

// ── recordBatchFinalize ──────────────────────────────────────────────────────

export interface BatchFinalizeFields {
  /** 'ended' for normal completion; 'failed' if the batch itself failed (not per-request errors). */
  status: TerminalBatchStatus;
  /** ISO timestamp when the batch ended. */
  endedAt: string;
  /** Final per-request counts from the Anthropic batch object. */
  counts: BatchProgressCounts;
  /**
   * Sum of usage.input_tokens * price + usage.output_tokens * price across all
   * succeeded requests. Null when zero requests ran (batch expired/canceled
   * before any work).
   */
  actualCostUsd?: number | null;
  /**
   * JSON-serializable error detail when counts.errored > 0.
   * Kept compact (e.g. first N error messages); the full detail lives in caller logs.
   */
  errorSummary?: Record<string, unknown> | null;
}

/**
 * Finalize a batch_runs row after collectResults + cost accounting. Stamps
 * ended_at, final counts, actual cost, and optional error summary.
 */
export async function recordBatchFinalize(
  db: AnyDb,
  anthropicId: string,
  fields: BatchFinalizeFields,
): Promise<void> {
  await db
    .update(batchRuns)
    .set({
      status: fields.status,
      endedAt: fields.endedAt,
      requestCountSucceeded: fields.counts.succeeded,
      requestCountErrored: fields.counts.errored,
      requestCountExpired: fields.counts.expired,
      requestCountCanceled: fields.counts.canceled,
      actualCostUsd: fields.actualCostUsd ?? null,
      errorSummary: fields.errorSummary ? JSON.stringify(fields.errorSummary) : null,
    })
    .where(eq(batchRuns.anthropicBatchId, anthropicId));
}
