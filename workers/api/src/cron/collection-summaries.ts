import { and, eq } from "drizzle-orm";
import { logEvent } from "@releases/lib/log-event";
import {
  etDayKey,
  etDayBoundsUtc,
  addDaysToDateKey,
  etWeekStart,
  weekBoundsUtc,
} from "@buildinternet/releases-core/dates";
import { releasePath } from "@buildinternet/releases-core/release-slug";
import { summarizeCollectionDay } from "@releases/ai-internal/collection-summary";
import {
  generateCollectionWeeklyDigest,
  isSubstantiveRelease,
  MIN_SUBSTANTIVE_RELEASES,
} from "@releases/ai-internal/collection-weekly-digest";
import type { TextModel } from "@releases/ai-internal/text-model";
import { createDb, type AnyDb } from "../db.js";
import { collections } from "@buildinternet/releases-core/schema";
import {
  getCollectionMembers,
  getCollectionDayReleases,
  getCollectionWeekReleases,
  listCollectionDailySummaries,
  upsertCollectionDailySummary,
  hasCollectionWeeklyDigest,
  upsertCollectionWeeklyDigest,
} from "../queries/collection-summaries.js";
import {
  resolveCollectionSummaryModel,
  resolveCollectionWeeklyDigestModel,
  type TextModelEnv,
} from "../lib/text-model.js";

export interface CollectionSummariesEnv extends TextModelEnv {
  DB: D1Database;
  CRON_ENABLED?: string;
  /** How many recent ET days to back-fill if a row is missing (default 2). */
  COLLECTION_SUMMARY_CATCHUP_DAYS?: string;
  /** How many recent ET weeks to back-fill if a row is missing (default 1). */
  COLLECTION_WEEKLY_DIGEST_CATCHUP_WEEKS?: string;
  /** TEST-ONLY: use this drizzle handle instead of createDb(env.DB). */
  _drizzleOverride?: AnyDb;
  /** TEST-ONLY: use this model instead of resolveCollectionSummaryModel(env). */
  _modelOverride?: TextModel;
  /** TEST-ONLY: use this model instead of resolveCollectionWeeklyDigestModel(env). */
  _weeklyDigestModelOverride?: TextModel;
}

export interface CollectionSummaryTarget {
  id: string;
  name: string;
}

export type CollectionSummaryOutcome = "generated" | "skipped" | "failed";

/** Enabled collections eligible for a summary run (optional single-collection scope). */
export async function listCollectionSummaryTargets(
  db: AnyDb,
  opts?: { collectionId?: string },
): Promise<CollectionSummaryTarget[]> {
  return db
    .select({ id: collections.id, name: collections.name })
    .from(collections)
    .where(
      and(
        eq(collections.dailySummaryEnabled, true),
        opts?.collectionId ? eq(collections.id, opts.collectionId) : undefined,
      ),
    );
}

/** ET day keys to summarize: catch-up window ending at the day before `todayEt`. */
export function collectionSummaryCatchupDates(todayEt: string, catchupDays: number): string[] {
  const days = Math.max(1, catchupDays);
  const dates: string[] = [];
  for (let i = 1; i <= days; i++) {
    dates.push(addDaysToDateKey(todayEt, -i));
  }
  return dates;
}

/**
 * Summarize one collection for one ET day. Per-collection failures are contained
 * here so workflow steps can retry independently.
 */
export async function summarizeCollectionForDay(
  db: AnyDb,
  model: TextModel,
  col: CollectionSummaryTarget,
  date: string,
  opts?: { force?: boolean },
): Promise<CollectionSummaryOutcome> {
  try {
    if (!opts?.force) {
      const existing = await listCollectionDailySummaries(db, col.id, date, date);
      if (existing.length > 0) return "skipped";
    }

    const members = await getCollectionMembers(db, col.id);
    const dayReleases = await getCollectionDayReleases(db, members, etDayBoundsUtc(date));
    if (dayReleases.length === 0) return "skipped";

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
    return "generated";
  } catch (err) {
    logEvent("error", {
      component: "collection-summaries",
      event: "generate-failed",
      collectionId: col.id,
      date,
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
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
  const cols = await listCollectionSummaryTargets(db, { collectionId: opts?.collectionId });
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const col of cols) {
    const outcome = await summarizeCollectionForDay(db, model, col, date, { force: opts?.force });
    if (outcome === "generated") generated++;
    else if (outcome === "skipped") skipped++;
    else failed++;
  }

  return { generated, skipped, failed };
}

/**
 * Nightly entrypoint. Summarizes the just-closed ET day plus a small catch-up
 * window of recent days that lack a row (guards against a missed run). Gated by
 * CRON_ENABLED; per-collection failures never abort the sweep.
 *
 * On the run where `scheduledTime` falls on an ET Monday, also generates the
 * weekly digest for the just-closed week (see `runCollectionWeeklyDigests`) —
 * same env, same failure-containment shape, reported as a separate log event
 * since it's a distinct content surface on a different cadence.
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
  for (const date of collectionSummaryCatchupDates(todayEt, catchup)) {
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
    mode: "inline",
    ...totals,
  });

  if (etWeekStart(todayEt) === todayEt) {
    await runCollectionWeeklyDigests(env, db, todayEt);
  }
}

// ── Weekly digests ────────────────────────────────────────────────

/** Enabled collections eligible for a weekly-digest run (optional single-collection scope). */
export async function listCollectionWeeklyDigestTargets(
  db: AnyDb,
  opts?: { collectionId?: string },
): Promise<CollectionSummaryTarget[]> {
  return db
    .select({ id: collections.id, name: collections.name })
    .from(collections)
    .where(
      and(
        eq(collections.weeklyDigestEnabled, true),
        opts?.collectionId ? eq(collections.id, opts.collectionId) : undefined,
      ),
    );
}

/** ET Monday week-start keys to digest: catch-up window ending at the just-closed week. */
export function collectionWeeklyDigestCatchupWeeks(
  todayEt: string,
  catchupWeeks: number,
): string[] {
  const weeks = Math.max(1, catchupWeeks);
  const thisWeekStart = etWeekStart(todayEt);
  const weekStarts: string[] = [];
  for (let i = 1; i <= weeks; i++) {
    weekStarts.push(addDaysToDateKey(thisWeekStart, -7 * i));
  }
  return weekStarts;
}

/**
 * Generate the weekly digest for one collection + week. Per-collection
 * failures are contained here so the sweep never aborts on one bad week.
 * Applies the quality floor (`MIN_SUBSTANTIVE_RELEASES`) before calling the
 * model — a thin week writes no row.
 */
export async function generateWeeklyDigestForCollection(
  db: AnyDb,
  model: TextModel,
  col: CollectionSummaryTarget,
  weekStart: string,
  opts?: { force?: boolean },
): Promise<CollectionSummaryOutcome> {
  try {
    if (!opts?.force) {
      const exists = await hasCollectionWeeklyDigest(db, col.id, weekStart);
      if (exists) return "skipped";
    }

    const members = await getCollectionMembers(db, col.id);
    const releases = await getCollectionWeekReleases(db, members, weekBoundsUtc(weekStart));
    const substantiveCount = releases.filter(isSubstantiveRelease).length;
    if (substantiveCount < MIN_SUBSTANTIVE_RELEASES) return "skipped";

    const idToPath = new Map(
      releases.map((r) => [r.id, releasePath({ id: r.id, title: r.title })]),
    );

    const result = await generateCollectionWeeklyDigest(
      model,
      { collectionName: col.name, weekStart, releases },
      idToPath,
    );

    await upsertCollectionWeeklyDigest(db, {
      collectionId: col.id,
      weekStart,
      title: result.title,
      intro: result.intro,
      body: result.body,
      releaseIds: result.releaseIds,
      releaseCount: releases.length,
      modelId: model.id,
    });
    return "generated";
  } catch (err) {
    logEvent("error", {
      component: "collection-weekly-digest",
      event: "generate-failed",
      collectionId: col.id,
      weekStart,
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}

/**
 * Generate weekly digests for one week across every enabled collection.
 * Exported for tests / the on-demand backfill trigger. `opts.collectionId`
 * scopes the run to a single collection; `opts.force` regenerates an
 * existing row (never set by the cron, so a week is digested once).
 */
export async function generateCollectionWeeklyDigestsForWeek(
  db: AnyDb,
  model: TextModel,
  weekStart: string,
  opts?: { collectionId?: string; force?: boolean },
): Promise<{ generated: number; skipped: number; failed: number }> {
  const cols = await listCollectionWeeklyDigestTargets(db, { collectionId: opts?.collectionId });
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const col of cols) {
    const outcome = await generateWeeklyDigestForCollection(db, model, col, weekStart, {
      force: opts?.force,
    });
    if (outcome === "generated") generated++;
    else if (outcome === "skipped") skipped++;
    else failed++;
  }

  return { generated, skipped, failed };
}

/**
 * Weekly-digest half of the nightly sweep, only run on the ET-Monday tick.
 * Digests the just-closed week (the week ending yesterday, Sunday) plus a
 * small catch-up window of recent weeks lacking a row. Model resolution is
 * independent of the daily model so a missing weekly-lane model never blocks
 * the daily sweep (and vice versa).
 */
export async function runCollectionWeeklyDigests(
  env: CollectionSummariesEnv,
  db: AnyDb,
  todayEt: string,
): Promise<void> {
  const model = env._weeklyDigestModelOverride ?? (await resolveCollectionWeeklyDigestModel(env));
  if (!model) {
    logEvent("warn", { component: "collection-weekly-digest", event: "no-model" });
    return;
  }

  const catchup = Math.max(1, Number(env.COLLECTION_WEEKLY_DIGEST_CATCHUP_WEEKS ?? "1") || 1);

  let totals = { generated: 0, skipped: 0, failed: 0 };
  for (const weekStart of collectionWeeklyDigestCatchupWeeks(todayEt, catchup)) {
    const r = await generateCollectionWeeklyDigestsForWeek(db, model, weekStart);
    totals = {
      generated: totals.generated + r.generated,
      skipped: totals.skipped + r.skipped,
      failed: totals.failed + r.failed,
    };
  }

  logEvent("info", {
    component: "collection-weekly-digest",
    event: "run-done",
    mode: "inline",
    ...totals,
  });
}
