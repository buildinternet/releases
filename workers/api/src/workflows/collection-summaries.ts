/**
 * CollectionSummariesWorkflow — durable nightly + on-demand collection daily
 * summary generation. One `step.do()` per (collection, ET day) so a transient
 * LLM failure retries only that unit. Cron dispatches when
 * `COLLECTION_SUMMARIES_WORKFLOW` is bound; otherwise the inline cron loop runs.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { etDayKey } from "@buildinternet/releases-core/dates";
import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js";
import { resolveCollectionSummaryModel, type TextModelEnv } from "../lib/text-model.js";
import {
  collectionSummaryCatchupDates,
  listCollectionSummaryTargets,
  summarizeCollectionForDay,
  type CollectionSummaryTarget,
} from "../cron/collection-summaries.js";

export type CollectionSummariesWorkflowParams = {
  scheduledTime: number;
  trigger: "cron" | "admin";
  /** ET day keys to summarize. Cron derives catch-up from env; admin passes one. */
  dates?: string[];
  collectionId?: string;
  force?: boolean;
  catchupDays?: number;
};

export type CollectionSummariesWorkflowEnv = TextModelEnv & {
  DB: D1Database;
  COLLECTION_SUMMARY_CATCHUP_DAYS?: string;
};

const RETRY_PLAN: WorkflowStepConfig = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};

const RETRY_SUMMARIZE: WorkflowStepConfig = {
  retries: { limit: 1, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
};

interface SummaryTask {
  collectionId: string;
  collectionName: string;
  date: string;
}

function resolveDates(
  env: CollectionSummariesWorkflowEnv,
  params: CollectionSummariesWorkflowParams,
): string[] {
  if (params.dates && params.dates.length > 0) return params.dates;
  const todayEt = etDayKey(new Date(params.scheduledTime));
  const catchup = Math.max(
    1,
    params.catchupDays ?? (Number(env.COLLECTION_SUMMARY_CATCHUP_DAYS ?? "2") || 2),
  );
  return collectionSummaryCatchupDates(todayEt, catchup);
}

export class CollectionSummariesWorkflow extends WorkflowEntrypoint<
  CollectionSummariesWorkflowEnv,
  CollectionSummariesWorkflowParams
> {
  async run(
    event: WorkflowEvent<CollectionSummariesWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { trigger, collectionId, force } = event.payload;
    const dates = resolveDates(this.env, event.payload);

    const plan = await step.do("plan", RETRY_PLAN, async (): Promise<{ tasks: SummaryTask[] }> => {
      const db = createDb(this.env.DB);
      const cols: CollectionSummaryTarget[] = await listCollectionSummaryTargets(db, {
        collectionId,
      });
      const model = await resolveCollectionSummaryModel(this.env);
      if (!model) {
        throw new NonRetryableError(
          "no collection summary model (ANTHROPIC_API_KEY or OPENROUTER_API_KEY required)",
        );
      }
      const tasks: SummaryTask[] = [];
      for (const date of dates) {
        for (const col of cols) {
          tasks.push({ collectionId: col.id, collectionName: col.name, date });
        }
      }
      return { tasks };
    });

    logEvent("info", {
      component: "collection-summaries-workflow",
      event: "plan-done",
      trigger,
      taskCount: plan.tasks.length,
      dates,
      collectionId: collectionId ?? null,
    });

    if (plan.tasks.length === 0) {
      logEvent("info", {
        component: "collection-summaries-workflow",
        event: "run-done",
        trigger,
        generated: 0,
        skipped: 0,
        failed: 0,
      });
      return;
    }

    let generated = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < plan.tasks.length; i++) {
      const task = plan.tasks[i];
      // oxlint-disable-next-line no-await-in-loop -- durable per-collection steps
      const outcome = await step.do(
        `summarize-${task.collectionId}-${task.date}`,
        RETRY_SUMMARIZE,
        async () => {
          const db = createDb(this.env.DB);
          const model = await resolveCollectionSummaryModel(this.env);
          if (!model) {
            throw new NonRetryableError("no collection summary model");
          }
          return summarizeCollectionForDay(
            db,
            model,
            { id: task.collectionId, name: task.collectionName },
            task.date,
            { force },
          );
        },
      );
      if (outcome === "generated") generated++;
      else if (outcome === "skipped") skipped++;
      else failed++;
    }

    logEvent("info", {
      component: "collection-summaries-workflow",
      event: "run-done",
      trigger,
      generated,
      skipped,
      failed,
    });
  }
}
