/**
 * Summary workflow for the poll-and-fetch fan-out. One instance is kicked per
 * hourly cron fire. It sleeps 10 minutes (allowing all per-source workflow
 * instances time to either complete or exhaust retries and record a failure),
 * then queries `workflow_failures` for that scheduledTime and sends one
 * `[alert]` email if any failures were recorded.
 *
 * One email per cron fire regardless of how many sources failed — keeps the
 * inbox manageable during a widespread provider outage.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { sendAlert, type AlertEnv } from "../lib/send-alert.js";

export type PollFetchSummaryEnv = AlertEnv & {
  DB: D1Database;
  ALERT_DEDUP_KV?: KVNamespace;
};

export type PollFetchSummaryParams = {
  /** The cron's scheduledTime — used to key the workflow_failures query. */
  scheduledTime: number;
};

type FailureRow = {
  source_id: string;
  step_name: string;
  error: string;
};

export class PollFetchSummaryWorkflow extends WorkflowEntrypoint<
  PollFetchSummaryEnv,
  PollFetchSummaryParams
> {
  async run(event: WorkflowEvent<PollFetchSummaryParams>, step: WorkflowStep): Promise<void> {
    const { scheduledTime } = event.payload;

    // Give per-source instances time to finish or exhaust retries.
    await step.sleep("wait-for-workflows", "10 minutes");

    const failures = await step.do("query-failures", async () => {
      const result = await this.env.DB.prepare(
        `SELECT source_id, step_name, error
         FROM workflow_failures
         WHERE scheduled_time = ?
         ORDER BY created_at ASC`,
      )
        .bind(scheduledTime)
        .all<FailureRow>();
      return result.results ?? [];
    });

    if (failures.length === 0) {
      console.log(
        `[poll-fetch-summary] scheduledTime=${scheduledTime}: no failures recorded; skipping alert`,
      );
      return;
    }

    const lines = [
      `${failures.length} source(s) failed during the poll-and-fetch fan-out.`,
      `Scheduled time: ${new Date(scheduledTime).toISOString()}`,
      "",
    ];
    for (const f of failures) {
      lines.push(`  source=${f.source_id}  step=${f.step_name}  error=${f.error}`);
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
