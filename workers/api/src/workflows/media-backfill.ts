/**
 * MediaBackfillWorkflow — durable operator backfills for R2 media mirroring,
 * inline-video retrofit, and GIF→MP4 transcode. Each batch is a retriable step;
 * the workflow loops until `remaining === 0` or `maxBatches` is hit.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js";
import type { MediaTransformBinding } from "../lib/media-ingest.js";
import {
  runMediaBackfill,
  runVideoBackfill,
  runGifTranscodeBackfill,
  MEDIA_BACKFILL_DEFAULT_LIMIT,
  MEDIA_BACKFILL_MAX_LIMIT,
  VIDEO_BACKFILL_DEFAULT_LIMIT,
  VIDEO_BACKFILL_MAX_LIMIT,
  GIF_BACKFILL_DEFAULT_LIMIT,
  GIF_BACKFILL_MAX_LIMIT,
  type MediaBackfillReport,
  type VideoBackfillReport,
  type GifBackfillReport,
} from "../lib/media-backfill.js";

export type MediaBackfillKind = "media" | "video" | "gif";

export type MediaBackfillWorkflowParams = {
  kind: MediaBackfillKind;
  sourceId?: string;
  releaseId?: string;
  all?: boolean;
  batchLimit?: number;
  dryRun?: boolean;
  /** Safety cap on batch steps (default 200). */
  maxBatches?: number;
};

export type MediaBackfillWorkflowEnv = {
  DB: D1Database;
  MEDIA?: R2Bucket;
  MEDIA_TRANSFORM?: MediaTransformBinding;
};

type BackfillBatchReport = MediaBackfillReport | VideoBackfillReport | GifBackfillReport;

const RETRY_BATCH: WorkflowStepConfig = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "15 minutes",
};

const DEFAULT_MAX_BATCHES = 200;

function clampLimit(kind: MediaBackfillKind, raw: number | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    if (kind === "gif") return GIF_BACKFILL_DEFAULT_LIMIT;
    if (kind === "video") return VIDEO_BACKFILL_DEFAULT_LIMIT;
    return MEDIA_BACKFILL_DEFAULT_LIMIT;
  }
  const floor = Math.max(1, Math.floor(n));
  if (kind === "gif") return Math.min(floor, GIF_BACKFILL_MAX_LIMIT);
  if (kind === "video") return Math.min(floor, VIDEO_BACKFILL_MAX_LIMIT);
  return Math.min(floor, MEDIA_BACKFILL_MAX_LIMIT);
}

async function runBackfillBatch(
  env: MediaBackfillWorkflowEnv,
  params: MediaBackfillWorkflowParams,
  limit: number,
): Promise<BackfillBatchReport> {
  const db = createDb(env.DB);
  const bucket = env.MEDIA;
  if (!bucket) throw new NonRetryableError("MEDIA bucket not bound");

  if (params.kind === "media") {
    return runMediaBackfill(db, bucket, {
      sourceId: params.sourceId,
      limit,
      dryRun: params.dryRun === true,
    });
  }

  if (params.kind === "video") {
    return runVideoBackfill(db, bucket, {
      sourceId: params.sourceId,
      releaseId: params.releaseId,
      limit,
      dryRun: params.dryRun === true,
    });
  }

  const mediaTransform = env.MEDIA_TRANSFORM;
  if (!mediaTransform) throw new NonRetryableError("MEDIA_TRANSFORM binding not bound");
  return runGifTranscodeBackfill(db, bucket, mediaTransform, {
    sourceId: params.sourceId,
    limit,
    dryRun: params.dryRun === true,
  });
}

export class MediaBackfillWorkflow extends WorkflowEntrypoint<
  MediaBackfillWorkflowEnv,
  MediaBackfillWorkflowParams
> {
  async run(
    event: WorkflowEvent<MediaBackfillWorkflowParams>,
    step: WorkflowStep,
  ): Promise<BackfillBatchReport> {
    const params = event.payload;
    const limit = clampLimit(params.kind, params.batchLimit);
    const maxBatches = Math.max(1, params.maxBatches ?? DEFAULT_MAX_BATCHES);

    if (params.dryRun === true) {
      return step.do("batch-dry-run", RETRY_BATCH, async () =>
        runBackfillBatch(this.env, params, limit),
      );
    }

    let last: BackfillBatchReport | null = null;
    for (let i = 0; i < maxBatches; i++) {
      // oxlint-disable-next-line no-await-in-loop -- durable batch steps until remaining=0
      const report = await step.do(`batch-${i}`, RETRY_BATCH, async () =>
        runBackfillBatch(this.env, { ...params, dryRun: false }, limit),
      );
      last = report;
      logEvent("info", {
        component: "media-backfill-workflow",
        event: "batch-done",
        kind: params.kind,
        batch: i,
        remaining: report.remaining,
        ...("releasesUpdated" in report ? { releasesUpdated: report.releasesUpdated } : {}),
      });
      if (report.remaining === 0) break;
    }

    if (!last) {
      throw new NonRetryableError("media backfill produced no batches");
    }

    logEvent("info", {
      component: "media-backfill-workflow",
      event: "run-done",
      kind: params.kind,
      remaining: last.remaining,
    });
    return last;
  }
}
