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
import { asc, eq, inArray } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { workflowFailures } from "../db/schema-workflow-failures.js";
import { sendAlert, type AlertEnv } from "../lib/send-alert.js";
import { formatPollFetchAlert, type PollFetchSourceDetail } from "../lib/poll-fetch-alert.js";
import { logEvent } from "@releases/lib/log-event";

/** D1 caps prepared statements at 100 bound params; chunk the IN list. */
const IN_LOOKUP_CHUNK = 90;

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

    // Resolve each failing source's org + source identity so the email names
    // the company and source instead of an opaque id. Best-effort: a lookup
    // error must not swallow the alert, so we fall back to an empty map and
    // the formatter degrades to the bare source id.
    const details = await step.do("resolve-source-details", async () => {
      const ids = [...new Set(failures.map((f) => f.sourceId))];
      const db = drizzle(this.env.DB);
      try {
        const chunks: Promise<PollFetchSourceDetail[]>[] = [];
        for (let i = 0; i < ids.length; i += IN_LOOKUP_CHUNK) {
          const slice = ids.slice(i, i + IN_LOOKUP_CHUNK);
          chunks.push(
            db
              .select({
                sourceId: sources.id,
                sourceName: sources.name,
                sourceSlug: sources.slug,
                sourceUrl: sources.url,
                sourceType: sources.type,
                orgName: organizations.name,
                orgSlug: organizations.slug,
              })
              .from(sources)
              .leftJoin(organizations, eq(sources.orgId, organizations.id))
              .where(inArray(sources.id, slice)),
          );
        }
        return (await Promise.all(chunks)).flat();
      } catch (err) {
        logEvent("warn", {
          component: "poll-fetch-summary",
          event: "resolve-source-details-failed",
          scheduledTime,
          err,
        });
        return [];
      }
    });

    const detailsById = new Map<string, PollFetchSourceDetail>(details.map((d) => [d.sourceId, d]));
    const alert = formatPollFetchAlert(failures, detailsById, scheduledTime);

    await step.do("send-alert", async () => {
      const alertEnv: AlertEnv = {
        SEND_EMAIL: this.env.SEND_EMAIL,
        EMAIL_NOTIFY_ENABLED: this.env.EMAIL_NOTIFY_ENABLED,
        EMAIL_NOTIFY_TO: this.env.EMAIL_NOTIFY_TO,
        EMAIL_FROM: this.env.EMAIL_FROM,
        ALERT_DEDUP_KV: this.env.ALERT_DEDUP_KV,
      };
      await sendAlert(alertEnv, { subject: alert.subject, body: alert.text, html: alert.html });
    });
  }
}
