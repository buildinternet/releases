/**
 * Summary workflow for the poll-and-fetch fan-out. Kicked once per hourly
 * fan-out. Sleeps the settle window so per-source instances have time to
 * complete or exhaust retries, then queries `workflow_failures` for that
 * scheduledTime and emits one aggregated alert if any sources failed.
 *
 * One email per cron fire regardless of failure count — keeps the inbox
 * manageable during a widespread provider outage.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { asc, eq } from "drizzle-orm";
import { workflowFailures } from "../db/schema-workflow-failures.js";
import { sendAlert, type AlertEnv } from "../lib/send-alert.js";
import { logEvent } from "@releases/lib/log-event";

/**
 * Window between fan-out and summary alert. Must exceed the per-source
 * workflow's max retry envelope so retried instances have time to either
 * succeed or land a row in `workflow_failures` before we read.
 *
 * Worst-case envelope per `poll-and-fetch.ts`:
 *   fetch:  3 retries × 5 min timeout + 30s/60s/120s backoff ≈ 19 min
 *   embed:  5 retries × 5 min timeout + 30s..8min backoff    ≈ 36 min
 *   refresh+embed (github sources only):                      ≈ 25 min
 * 30 min is comfortably above the fetch window and the realistic
 * embed-failure window (full retry storms past 30 min are pathological).
 */
const SETTLE_WINDOW = "30 minutes";

export type PollFetchSummaryEnv = AlertEnv & {
  DB: D1Database;
  ALERT_DEDUP_KV?: KVNamespace;
};

export type PollFetchSummaryParams = {
  /** The cron's scheduledTime — used to key the workflow_failures query. */
  scheduledTime: number;
};

export class PollFetchSummaryWorkflow extends WorkflowEntrypoint<
  PollFetchSummaryEnv,
  PollFetchSummaryParams
> {
  async run(event: WorkflowEvent<PollFetchSummaryParams>, step: WorkflowStep): Promise<void> {
    const { scheduledTime } = event.payload;

    await step.sleep("wait-for-workflows", SETTLE_WINDOW);

    const failures = await step.do("query-failures", async () => {
      const db = drizzle(this.env.DB);
      return await db
        .select({
          sourceId: workflowFailures.sourceId,
          stepName: workflowFailures.stepName,
          error: workflowFailures.error,
        })
        .from(workflowFailures)
        .where(eq(workflowFailures.scheduledTime, scheduledTime))
        .orderBy(asc(workflowFailures.createdAt));
    });

    if (failures.length === 0) {
      logEvent("info", { component: "poll-fetch-summary", event: "no-failures", scheduledTime });
      return;
    }

    const lines = [
      `${failures.length} source(s) failed during the poll-and-fetch fan-out.`,
      `Scheduled time: ${new Date(scheduledTime).toISOString()}`,
      "",
    ];
    for (const f of failures) {
      lines.push(`  source=${f.sourceId}  step=${f.stepName}  error=${f.error}`);
    }

    await step.do("send-alert", async () => {
      await sendAlert(
        {
          SEND_EMAIL: this.env.SEND_EMAIL,
          EMAIL_NOTIFY_ENABLED: this.env.EMAIL_NOTIFY_ENABLED,
          EMAIL_NOTIFY_TO: this.env.EMAIL_NOTIFY_TO,
          EMAIL_FROM: this.env.EMAIL_FROM,
          ALERT_DEDUP_KV: this.env.ALERT_DEDUP_KV,
        },
        {
          subject: `[alert] poll-and-fetch: ${failures.length} source(s) failed (scheduledTime=${scheduledTime})`,
          body: lines.join("\n"),
        },
      );
    });
  }
}
