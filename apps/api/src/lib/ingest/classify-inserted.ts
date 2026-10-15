/**
 * Marketing classification for rows already written by a bulk insert.
 *
 * The poll path classifies before insert (`classifyMarketingForReleases`).
 * `POST /releases/batch` — local ingest, publish tokens, the GitHub Action —
 * writes through `ingestReleaseBatch` and never entered that function, so a
 * source with `metadata.marketingFilter` landed its whole history with no
 * verdict. This pass runs in the post-insert effects: load the new rows,
 * classify every one (a large insert is not dropped), and suppress marketing
 * hits before publish / summarize / embed.
 *
 * Fail-open: a missing provider or a per-row throw leaves that row visible.
 */
import { eq, inArray } from "drizzle-orm";
import { releases } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/feed.js";
import {
  classifyMarketing,
  type MarketingClassifierResult,
} from "@releases/ai-internal/marketing-classifier";
import { splitModelId } from "@releases/ai-internal/text-model";
import { logEvent } from "@releases/lib/log-event";
import { classifyProviderQuota } from "@releases/lib/provider-quota";
import type { D1Db } from "../../db.js";
import { resolveMarketingModel, type TextModelEnv } from "../ai/text-model.js";
import { loadMarketingThreshold } from "../classification/marketing-classifier-settings.js";
import {
  writeClassificationPoint,
  type ClassificationDataset,
} from "../classification/classification-schema.js";
import { marketingClassificationInput } from "../classification/classification-points.js";
import { RELEASES_ID_IN_CHUNK_SIZE } from "../d1-limits.js";

export interface ClassifyInsertedEnv extends TextModelEnv {
  RELEASE_CLASSIFICATIONS_AE?: ClassificationDataset;
}

interface InsertedReleaseRow {
  id: string;
  title: string;
  content: string;
  url: string | null;
}

/**
 * Classify `insertedIds` when the source opted into `marketingFilter`.
 * Returns the ids suppressed as marketing. Empty when the filter is off,
 * the provider is missing, or nothing was marketing.
 */
export async function classifyInsertedReleases(
  db: D1Db,
  env: ClassifyInsertedEnv,
  source: Source,
  insertedIds: string[],
): Promise<Set<string>> {
  const meta = getSourceMeta(source);
  if (meta.marketingFilter !== true || insertedIds.length === 0) return new Set();

  const rows = await loadInsertedRows(db, insertedIds);
  if (rows.length === 0) return new Set();

  const threshold = await loadMarketingThreshold(env.DB);
  const model = await resolveMarketingModel(env);
  if (!model) {
    logEvent("warn", {
      component: "sources-batch",
      event: "marketing-filter-no-api-key",
      sourceSlug: source.slug,
      candidateCount: rows.length,
    });
    for (const row of rows) {
      writeClassificationPoint(
        env.RELEASE_CLASSIFICATIONS_AE,
        env.ENVIRONMENT,
        marketingClassificationInput(
          {
            disposition: "skipped",
            failureCategory: "no_provider",
            verdict: null,
            provider: null,
            model: null,
            durationMs: null,
          },
          { origin: "ingest", releaseId: row.id, sourceId: source.id, threshold },
        ),
      );
    }
    return new Set();
  }

  const { provider, model: modelName } = splitModelId(model.id);
  const suppressed = new Set<string>();
  let failed = 0;
  const startedAt = Date.now();

  for (const row of rows) {
    const itemStarted = Date.now();
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential per item, same bound as the poll path
      const verdict = await classifyMarketing(
        model,
        {
          sourceName: source.name,
          title: row.title,
          content: row.content,
          url: row.url,
          hint: meta.marketingFilterHint ?? null,
          sourceId: source.id,
        },
        { threshold },
      );
      if (verdict.isMarketing) {
        // oxlint-disable-next-line no-await-in-loop -- one suppress write per marketing hit
        await suppressMarketing(db, row.id, verdict);
        suppressed.add(row.id);
      }
      writeClassificationPoint(
        env.RELEASE_CLASSIFICATIONS_AE,
        env.ENVIRONMENT,
        marketingClassificationInput(
          {
            disposition: verdict.isMarketing ? "suppressed" : "kept",
            failureCategory: null,
            verdict,
            provider,
            model: modelName,
            durationMs: Date.now() - itemStarted,
          },
          { origin: "ingest", releaseId: row.id, sourceId: source.id, threshold },
        ),
      );
    } catch (err) {
      failed++;
      const quota = classifyProviderQuota(err);
      if (quota) {
        logEvent("error", {
          component: "sources-batch",
          event: "provider-quota-exhausted",
          lane: "marketing-classifier",
          provider: quota.provider,
          regainAccessAt: quota.regainAccessAt?.toISOString() ?? null,
          providerMessage: quota.message,
          sourceSlug: source.slug,
        });
      }
      logEvent("warn", {
        component: "sources-batch",
        event: "marketing-filter-classify-failed",
        sourceSlug: source.slug,
        releaseId: row.id,
        err,
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
            durationMs: Date.now() - itemStarted,
          },
          { origin: "ingest", releaseId: row.id, sourceId: source.id, threshold },
        ),
      );
    }
  }

  logEvent("info", {
    component: "sources-batch",
    event: "marketing-filter-applied",
    sourceSlug: source.slug,
    modelId: model.id,
    threshold,
    classified: rows.length,
    suppressed: suppressed.size,
    failed,
    durationMs: Date.now() - startedAt,
  });

  return suppressed;
}

async function loadInsertedRows(db: D1Db, ids: string[]): Promise<InsertedReleaseRow[]> {
  const rows: InsertedReleaseRow[] = [];
  for (let i = 0; i < ids.length; i += RELEASES_ID_IN_CHUNK_SIZE) {
    const slice = ids.slice(i, i + RELEASES_ID_IN_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- D1 chunked select (100 bind param limit)
    const chunk = await db
      .select({
        id: releases.id,
        title: releases.title,
        content: releases.content,
        url: releases.url,
      })
      .from(releases)
      .where(inArray(releases.id, slice));
    rows.push(...chunk);
  }
  return rows;
}

async function suppressMarketing(
  db: D1Db,
  id: string,
  verdict: MarketingClassifierResult,
): Promise<void> {
  await db
    .update(releases)
    .set({
      suppressed: true,
      suppressedReason: `marketing_classifier:${verdict.reason}`,
    })
    .where(eq(releases.id, id));
}
