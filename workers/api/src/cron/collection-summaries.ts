import { and, eq } from "drizzle-orm";
import { logEvent } from "@releases/lib/log-event";
import { etDayKey, etDayBoundsUtc, addDaysToDateKey } from "@buildinternet/releases-core/dates";
import { summarizeCollectionDay } from "@releases/ai-internal/collection-summary";
import type { TextModel } from "@releases/ai-internal/text-model";
import { createDb, type AnyDb } from "../db.js";
import { collections } from "@buildinternet/releases-core/schema";
import {
  getCollectionMembers,
  getCollectionDayReleases,
  listCollectionDailySummaries,
  upsertCollectionDailySummary,
} from "../queries/collection-summaries.js";
import { resolveCollectionSummaryModel, type TextModelEnv } from "../lib/text-model.js";

export interface CollectionSummariesEnv extends TextModelEnv {
  DB: D1Database;
  CRON_ENABLED?: string;
  /** How many recent ET days to back-fill if a row is missing (default 2). */
  COLLECTION_SUMMARY_CATCHUP_DAYS?: string;
  /** TEST-ONLY: use this drizzle handle instead of createDb(env.DB). */
  _drizzleOverride?: AnyDb;
  /** TEST-ONLY: use this model instead of resolveCollectionSummaryModel(env). */
  _modelOverride?: TextModel;
}

/**
 * Generate summaries for one ET day across every enabled collection. Exported
 * for tests. Pass `opts.collectionId` to scope the run to a single collection
 * (used by the on-demand workflow trigger); omit it for the full nightly sweep.
 * `opts.force` regenerates a day that already has a row (the on-demand trigger's
 * manual-regeneration path); the cron never sets it, so a day is summarized once.
 */
export async function generateCollectionSummariesForDay(
  db: AnyDb,
  model: TextModel,
  date: string,
  opts?: { collectionId?: string; force?: boolean },
): Promise<{ generated: number; skipped: number; failed: number }> {
  const cols = await db
    .select({ id: collections.id, name: collections.name })
    .from(collections)
    // `and()` drops `undefined`, so with no collectionId this is the full sweep.
    .where(
      and(
        eq(collections.dailySummaryEnabled, true),
        opts?.collectionId ? eq(collections.id, opts.collectionId) : undefined,
      ),
    );

  const window = etDayBoundsUtc(date);
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const col of cols) {
    try {
      if (!opts?.force) {
        const existing = await listCollectionDailySummaries(db, col.id, date, date);
        if (existing.length > 0) {
          skipped++;
          continue;
        }
      }

      const members = await getCollectionMembers(db, col.id);
      const dayReleases = await getCollectionDayReleases(db, members, window);
      if (dayReleases.length === 0) {
        skipped++;
        continue;
      }

      const result = await summarizeCollectionDay(model, {
        collectionName: col.name,
        date,
        releases: dayReleases,
      });

      await upsertCollectionDailySummary(db, {
        collectionId: col.id,
        summaryDate: date,
        title: result.title,
        summary: result.summary,
        takeaways: result.takeaways,
        releaseCount: dayReleases.length,
        modelId: model.id,
      });
      generated++;
    } catch (err) {
      failed++;
      logEvent("error", {
        component: "collection-summaries",
        event: "generate-failed",
        collectionId: col.id,
        date,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { generated, skipped, failed };
}

/**
 * Nightly entrypoint. Summarizes the just-closed ET day plus a small catch-up
 * window of recent days that lack a row (guards against a missed run). Gated by
 * CRON_ENABLED; per-collection failures never abort the sweep.
 */
export async function runCollectionSummaries(
  env: CollectionSummariesEnv,
  scheduledTime: Date,
): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "collection-summaries", event: "cron-disabled" });
    return;
  }

  const model = env._modelOverride ?? (await resolveCollectionSummaryModel(env));
  if (!model) {
    logEvent("warn", { component: "collection-summaries", event: "no-model" });
    return;
  }

  const db = env._drizzleOverride ?? createDb(env.DB);
  const todayEt = etDayKey(scheduledTime);
  const catchup = Math.max(1, Number(env.COLLECTION_SUMMARY_CATCHUP_DAYS ?? "2") || 2);

  let totals = { generated: 0, skipped: 0, failed: 0 };
  for (let i = 1; i <= catchup; i++) {
    const date = addDaysToDateKey(todayEt, -i);
    const r = await generateCollectionSummariesForDay(db, model, date);
    totals = {
      generated: totals.generated + r.generated,
      skipped: totals.skipped + r.skipped,
      failed: totals.failed + r.failed,
    };
  }

  logEvent("info", {
    component: "collection-summaries",
    event: "run-done",
    ...totals,
  });
}
