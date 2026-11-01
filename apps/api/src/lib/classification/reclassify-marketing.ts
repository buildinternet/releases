/**
 * Re-run the marketing classifier on releases that are already stored.
 *
 * Ingest classifies only genuinely-new items, before insert. A bulk import
 * that skipped that pass (or a threshold change) leaves rows with no verdict.
 * This pass loads the stored title/content, classifies each one the same way
 * ingest does, and writes `suppressed` / `suppressedReason`.
 *
 * A not-marketing verdict clears a `marketing_classifier:*` reason. It does
 * not clear a manual or `force_refetch` suppression — those rows are reported
 * as `held`. A marketing verdict always suppresses.
 *
 * Per request the caller passes at most {@link RECLASSIFY_MAX} ids. A source
 * sweep pages with `after` so a long history is several requests, each one
 * short enough to finish inside a worker invocation.
 */
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { releases, sources } from "@buildinternet/releases-core/schema";
import { chunkArray, IN_ARRAY_CHUNK_SIZE } from "@buildinternet/releases-core/d1-limits";
import {
  classifyMarketing,
  type MarketingClassifierResult,
} from "@releases/ai-internal/marketing-classifier";
import { splitModelId } from "@releases/ai-internal/text-model";
import { logEvent } from "@releases/lib/log-event";
import { classifyProviderQuota } from "@releases/lib/provider-quota";
import type { D1Db } from "../../db.js";
import { resolveMarketingModel, type TextModelEnv } from "../ai/text-model.js";
import { loadMarketingThreshold } from "./marketing-classifier-settings.js";
import { writeClassificationPoint, type ClassificationDataset } from "./classification-schema.js";
import { marketingClassificationInput } from "./classification-points.js";

/** Ids classified in one admin request. Sequential model calls; keep the wave short. */
export const RECLASSIFY_MAX = 25;

export interface ReclassifyEnv extends TextModelEnv {
  RELEASE_CLASSIFICATIONS_AE?: ClassificationDataset;
}

export type ReclassifyDisposition = "suppressed" | "kept" | "failed" | "held";

export interface ReclassifyResultRow {
  id: string;
  disposition: ReclassifyDisposition;
  reason: string | null;
  /** Stored value after this call, or the value a write would store when `dryRun`. */
  suppressed: boolean;
  suppressedReason: string | null;
  /** True only when this call wrote the row. */
  applied: boolean;
}

export interface ReclassifyReport {
  dryRun: boolean;
  threshold: number;
  provider: string | null;
  model: string | null;
  classified: number;
  suppressed: number;
  kept: number;
  failed: number;
  held: number;
  missing: string[];
  /** True when rows were selected but no classifier model could be resolved. */
  providerMissing: boolean;
  /** Set when a source page has more rows after this one. Pass it back as `after`. */
  nextAfter: string | null;
  results: ReclassifyResultRow[];
}

interface StoredRelease {
  id: string;
  title: string;
  content: string;
  url: string | null;
  /** Drizzle's boolean mode is null when the column is null. */
  suppressed: boolean | null;
  suppressedReason: string | null;
  sourceId: string;
  sourceName: string;
  sourceSlug: string;
  metadata: string | null;
}

const RELEASE_COLUMNS = {
  id: releases.id,
  title: releases.title,
  content: releases.content,
  url: releases.url,
  suppressed: releases.suppressed,
  suppressedReason: releases.suppressedReason,
  sourceId: releases.sourceId,
  sourceName: sources.name,
  sourceSlug: sources.slug,
  metadata: sources.metadata,
};

function hintOf(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { marketingFilterHint?: unknown };
    return typeof parsed.marketingFilterHint === "string" ? parsed.marketingFilterHint : null;
  } catch {
    return null;
  }
}

function classifierOwns(reason: string | null): boolean {
  return reason == null || reason.startsWith("marketing_classifier:");
}

function isSuppressed(value: boolean | null): boolean {
  return value === true;
}

/**
 * The row we would store. `held` means a non-classifier suppression stays put
 * even though the verdict is not marketing.
 */
function plannedState(
  row: StoredRelease,
  verdict: MarketingClassifierResult,
): { suppressed: boolean; suppressedReason: string | null; held: boolean } {
  // A manual or force-refetch decision stays, even when this pass says marketing.
  if (isSuppressed(row.suppressed) && !classifierOwns(row.suppressedReason)) {
    return { suppressed: true, suppressedReason: row.suppressedReason, held: true };
  }
  if (verdict.isMarketing) {
    return {
      suppressed: true,
      suppressedReason: `marketing_classifier:${verdict.reason}`,
      held: false,
    };
  }
  return { suppressed: false, suppressedReason: null, held: false };
}

async function loadByIds(db: D1Db, ids: string[]): Promise<StoredRelease[]> {
  const rows: StoredRelease[] = [];
  for (const chunk of chunkArray(ids, IN_ARRAY_CHUNK_SIZE)) {
    // oxlint-disable-next-line no-await-in-loop -- D1 chunked select (100 bind param limit)
    const found = await db
      .select(RELEASE_COLUMNS)
      .from(releases)
      .innerJoin(sources, eq(sources.id, releases.sourceId))
      .where(inArray(releases.id, chunk));
    rows.push(...found);
  }
  return rows;
}

/**
 * Classify `ids` in the given order. `nextAfter` is unused here; the source
 * pager sets it.
 */
export async function reclassifyReleaseIds(
  db: D1Db,
  env: ReclassifyEnv,
  ids: string[],
  opts: { dryRun: boolean },
): Promise<ReclassifyReport> {
  const threshold = await loadMarketingThreshold(env.DB);
  const missing: string[] = [];
  const empty = (provider: string | null, model: string | null): ReclassifyReport => ({
    dryRun: opts.dryRun,
    threshold,
    provider,
    model,
    classified: 0,
    suppressed: 0,
    kept: 0,
    failed: 0,
    held: 0,
    missing,
    providerMissing: false,
    nextAfter: null,
    results: [],
  });

  if (ids.length === 0) return empty(null, null);

  const loaded = await loadByIds(db, ids);
  const byId = new Map(loaded.map((row) => [row.id, row]));
  const ordered: StoredRelease[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) ordered.push(row);
    else missing.push(id);
  }
  if (ordered.length === 0) return empty(null, null);

  const model = await resolveMarketingModel(env);
  if (!model) {
    logEvent("warn", {
      component: "marketing-reclassify",
      event: "marketing-filter-no-api-key",
      candidateCount: ordered.length,
    });
    const report = empty(null, null);
    report.providerMissing = true;
    return report;
  }

  const { provider, model: modelName } = splitModelId(model.id);
  const results: ReclassifyResultRow[] = [];
  let suppressed = 0;
  let kept = 0;
  let failed = 0;
  let held = 0;

  for (const row of ordered) {
    const started = Date.now();
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential, same bound as ingest
      const verdict = await classifyMarketing(
        model,
        {
          sourceName: row.sourceName,
          title: row.title,
          content: row.content,
          url: row.url,
          hint: hintOf(row.metadata),
          sourceId: row.sourceId,
        },
        { threshold },
      );
      const next = plannedState(row, verdict);
      let disposition: ReclassifyDisposition = next.held
        ? "held"
        : next.suppressed
          ? "suppressed"
          : "kept";
      const changed =
        isSuppressed(row.suppressed) !== next.suppressed ||
        row.suppressedReason !== next.suppressedReason;
      let applied = false;
      if (!opts.dryRun && changed && !next.held) {
        const reasonMatch =
          row.suppressedReason == null
            ? isNull(releases.suppressedReason)
            : eq(releases.suppressedReason, row.suppressedReason);
        const suppressedMatch = isSuppressed(row.suppressed)
          ? eq(releases.suppressed, true)
          : or(eq(releases.suppressed, false), isNull(releases.suppressed));
        // oxlint-disable-next-line no-await-in-loop -- one write per changed row
        const [written] = await db
          .update(releases)
          .set({ suppressed: next.suppressed, suppressedReason: next.suppressedReason })
          .where(and(eq(releases.id, row.id), reasonMatch, suppressedMatch!))
          .returning({ id: releases.id });
        applied = written != null;
        if (!written) disposition = "held";
      }
      if (disposition === "suppressed") suppressed++;
      else if (disposition === "held") held++;
      else kept++;
      results.push({
        id: row.id,
        disposition,
        reason: verdict.reason,
        suppressed: next.suppressed,
        suppressedReason: next.suppressedReason,
        applied,
      });
      writeClassificationPoint(
        env.RELEASE_CLASSIFICATIONS_AE,
        env.ENVIRONMENT,
        marketingClassificationInput(
          {
            disposition: next.held
              ? "skipped"
              : disposition === "suppressed"
                ? "suppressed"
                : "kept",
            failureCategory: next.held ? "manual_hold" : null,
            verdict: next.held ? null : verdict,
            provider,
            model: modelName,
            durationMs: Date.now() - started,
          },
          { origin: "manual", releaseId: row.id, sourceId: row.sourceId, threshold },
        ),
      );
    } catch (err) {
      failed++;
      const quota = classifyProviderQuota(err);
      if (quota) {
        logEvent("error", {
          component: "marketing-reclassify",
          event: "provider-quota-exhausted",
          lane: "marketing-classifier",
          provider: quota.provider,
          regainAccessAt: quota.regainAccessAt?.toISOString() ?? null,
          providerMessage: quota.message,
          releaseId: row.id,
        });
      }
      logEvent("warn", {
        component: "marketing-reclassify",
        event: "marketing-filter-classify-failed",
        releaseId: row.id,
        sourceSlug: row.sourceSlug,
        err,
      });
      results.push({
        id: row.id,
        disposition: "failed",
        reason: null,
        suppressed: isSuppressed(row.suppressed),
        suppressedReason: row.suppressedReason,
        applied: false,
      });
      writeClassificationPoint(
        env.RELEASE_CLASSIFICATIONS_AE,
        env.ENVIRONMENT,
        marketingClassificationInput(
          {
            disposition: "failed",
            failureCategory: "classify_error",
            verdict: null,
            provider,
            model: modelName,
            durationMs: Date.now() - started,
          },
          { origin: "manual", releaseId: row.id, sourceId: row.sourceId, threshold },
        ),
      );
    }
  }

  logEvent("info", {
    component: "marketing-reclassify",
    event: "reclassify-applied",
    dryRun: opts.dryRun,
    classified: results.length - failed,
    suppressed,
    kept,
    held,
    failed,
    threshold,
    modelId: model.id,
  });

  return {
    dryRun: opts.dryRun,
    threshold,
    provider,
    model: modelName,
    classified: results.length - failed,
    suppressed,
    kept,
    failed,
    held,
    missing,
    providerMissing: false,
    nextAfter: null,
    results,
  };
}

/** One page of a source, oldest id first. `nextAfter` is the last id when more remain. */
export async function reclassifySourcePage(
  db: D1Db,
  env: ReclassifyEnv,
  sourceId: string,
  opts: { dryRun: boolean; limit: number; after?: string },
): Promise<ReclassifyReport> {
  const page = await db
    .select({ id: releases.id })
    .from(releases)
    .where(
      opts.after
        ? and(eq(releases.sourceId, sourceId), gt(releases.id, opts.after))
        : eq(releases.sourceId, sourceId),
    )
    .orderBy(asc(releases.id))
    .limit(opts.limit + 1);
  const hasMore = page.length > opts.limit;
  const ids = (hasMore ? page.slice(0, opts.limit) : page).map((row) => row.id);
  const report = await reclassifyReleaseIds(db, env, ids, { dryRun: opts.dryRun });
  report.nextAfter = hasMore ? (ids[ids.length - 1] ?? null) : null;
  return report;
}
