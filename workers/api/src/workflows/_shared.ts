/**
 * Cross-workflow primitives. Constants and helpers shared between workflow
 * classes (phase 1 sweep, phase 2 poll-and-fetch, phase 3 onboarding).
 */

import { workflowFailures } from "../db/schema-workflow-failures.js";
import { logEvent } from "@releases/lib/log-event";
import { dbErrorLogFields } from "@releases/lib/db-errors";

/**
 * Sentinel for "source row was deleted between dispatch and workflow start".
 * Matched verbatim in catch handlers so unrelated NonRetryableErrors that
 * happen to mention "not found" (e.g. a 404 from a downstream API) still get
 * recorded as workflow failures rather than silently swallowed.
 */
export const SOURCE_DELETED_SENTINEL = "load-source: source row deleted";

/**
 * Cloudflare surfaces this exact message when a Durable Object is reset because
 * a new Worker version was deployed. Workflows run on Durable Objects, so every
 * API-worker deploy resets in-flight `poll-and-fetch` instances mid-step. The
 * reset only clears in-memory state — the durable step log survives, the engine
 * resumes the instance on the new code, and the source completes within the same
 * fire (verified: reset → `done` ~5 min later, nothing missed). It is transient
 * deploy churn, never an actionable source failure, so we never persist it to
 * `workflow_failures` (which would fire a false-alarm alert email).
 *
 * Substring (not equality) so a wrapped variant — e.g. `fetch <slug>: <msg>` —
 * is still recognized.
 */
const DO_RESET_MARKER = "Durable Object reset because its code was updated";

export function isDurableObjectReset(message: string): boolean {
  return message.includes(DO_RESET_MARKER);
}

export interface RecordWorkflowFailureArgs {
  /** Per-workflow id prefix (e.g. "wf-fail-onboard-"). The full id is `${prefix}${scheduledTime}-${sourceId}`. */
  idPrefix: string;
  scheduledTime: number;
  sourceId: string;
  stepName: string;
  error: string;
  /** Tag included in the warn log if the failure-row write itself fails. */
  logTag: string;
}

/**
 * Idempotent: deterministic id + onConflictDoUpdate. Safe to call from a step
 * retry. Best-effort: a write failure here is logged and swallowed so it
 * doesn't mask the original error.
 */
export async function recordWorkflowFailure(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  args: RecordWorkflowFailureArgs,
): Promise<void> {
  // Durable Object reset = deploy churn that self-heals; don't create an alert
  // row for it. Centralized here so every caller (poll-and-fetch, onboard-source)
  // is covered. See {@link isDurableObjectReset}.
  if (isDurableObjectReset(args.error)) {
    logEvent("info", {
      component: args.logTag,
      event: "do-reset-skip-record",
      sourceId: args.sourceId,
      step: args.stepName,
    });
    return;
  }
  const now = new Date().toISOString();
  try {
    await db
      .insert(workflowFailures)
      .values({
        id: `${args.idPrefix}${args.scheduledTime}-${args.sourceId}`,
        scheduledTime: args.scheduledTime,
        sourceId: args.sourceId,
        stepName: args.stepName,
        error: args.error,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: workflowFailures.id,
        set: {
          stepName: args.stepName,
          error: args.error,
          createdAt: now,
        },
      });
  } catch (dbErr) {
    logEvent("warn", {
      component: args.logTag,
      event: "record-failure-row-failed",
      err: dbErr instanceof Error ? dbErr : String(dbErr),
      ...dbErrorLogFields(dbErr),
    });
  }
}
