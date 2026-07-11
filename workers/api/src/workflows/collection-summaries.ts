/**
 * CollectionSummariesWorkflow — durable nightly + on-demand collection daily
 * summary generation. One `step.do()` per (collection, ET day) so a transient
 * LLM failure retries only that unit. Cron dispatches when
 * `COLLECTION_SUMMARIES_WORKFLOW` is bound; otherwise the inline cron loop runs.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { etDayKey, etWeekStart } from "@buildinternet/releases-core/dates";
import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js";
import {
  resolveCollectionSummaryModel,
  resolveCollectionWeeklyDigestModel,
  type TextModelEnv,
} from "../lib/text-model.js";
import {
  collectionSummaryCatchupDates,
  collectionWeeklyDigestCatchupWeeks,
  listCollectionSummaryTargets,
  listCollectionWeeklyDigestTargets,
  summarizeCollectionForDay,
  generateWeeklyDigestForCollection,
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
  COLLECTION_WEEKLY_DIGEST_CATCHUP_WEEKS?: string;
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

interface WeeklyDigestTask {
  collectionId: string;
  collectionName: string;
  weekStart: string;
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

    // Weekly digests ride the same nightly cron dispatch as the daily rollup
    // above, but only fire on the ET-Monday tick — same shape as the inline
    // `runCollectionSummaries` cron path, just as durable per-(collection,
    // week) steps instead of a plain loop. The admin on-demand trigger for
    // THIS workflow (daily catch-up regen) never touches weekly digests —
    // that's the separate `POST /workflows/backfill-weekly-digests` route.
    if (trigger === "cron") {
      const todayEt = etDayKey(new Date(event.payload.scheduledTime));
      if (etWeekStart(todayEt) === todayEt) {
        await this.runWeeklyDigests(step, todayEt);
      }
    }
  }

  private async runWeeklyDigests(step: WorkflowStep, todayEt: string): Promise<void> {
    const catchup = Math.max(
      1,
      Number(this.env.COLLECTION_WEEKLY_DIGEST_CATCHUP_WEEKS ?? "1") || 1,
    );
    const weekStarts = collectionWeeklyDigestCatchupWeeks(todayEt, catchup);

    const plan = await step.do(
      "weekly-digest-plan",
      RETRY_PLAN,
      async (): Promise<{ tasks: WeeklyDigestTask[] }> => {
        const db = createDb(this.env.DB);
        const cols: CollectionSummaryTarget[] = await listCollectionWeeklyDigestTargets(db);
        const model = await resolveCollectionWeeklyDigestModel(this.env);
        if (!model) {
          throw new NonRetryableError(
            "no collection weekly digest model (ANTHROPIC_API_KEY or OPENROUTER_API_KEY required)",
          );
        }
        const tasks: WeeklyDigestTask[] = [];
        for (const weekStart of weekStarts) {
          for (const col of cols) {
            tasks.push({ collectionId: col.id, collectionName: col.name, weekStart });
          }
        }
        return { tasks };
      },
    );

    logEvent("info", {
      component: "collection-weekly-digest-workflow",
      event: "plan-done",
      taskCount: plan.tasks.length,
      weeks: weekStarts,
    });

    let generated = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < plan.tasks.length; i++) {
      const task = plan.tasks[i];
      // oxlint-disable-next-line no-await-in-loop -- durable per-collection steps
      const outcome = await step.do(
        `weekly-digest-${task.collectionId}-${task.weekStart}`,
        RETRY_SUMMARIZE,
        async () => {
          const db = createDb(this.env.DB);
          const model = await resolveCollectionWeeklyDigestModel(this.env);
          if (!model) {
            throw new NonRetryableError("no collection weekly digest model");
          }
          return generateWeeklyDigestForCollection(
            db,
            model,
            { id: task.collectionId, name: task.collectionName },
            task.weekStart,
          );
        },
      );
      if (outcome === "generated") generated++;
      else if (outcome === "skipped") skipped++;
      else failed++;
    }

    logEvent("info", {
      component: "collection-weekly-digest-workflow",
      event: "run-done",
      generated,
      skipped,
      failed,
    });
  }
}
