/**
 * R2 backfill for releases stored before (or while) ingest-time R2 mirroring
 * (`MEDIA_R2_UPLOAD_ENABLED`) was off, so their `media` still points at
 * third-party URLs with no `r2Key`.
 *
 * The standard ingest upsert never touches `media` on conflict
 * (`RELEASE_URL_UPSERT`) and the ingest media pre-pass skips already-stored URLs
 * (`selectExistingReleaseUrls`), so re-fetching a source can NOT backfill
 * existing rows — this is the only path that does. It re-runs the exact ingest
 * mirror (`processMediaForR2`) and writes the stamped media JSON back.
 *
 * Pairs with the `POST /v1/workflows/backfill-media` route. Sibling of
 * `lib/source-backfill.ts`.
 */
import { and, count, desc, eq, sql } from "drizzle-orm";
import { releases } from "@buildinternet/releases-core/schema";
import { filterJunkMedia } from "@releases/rendering/media-filter.js";
import { processMediaForR2 } from "./media-ingest.js";
import type { createDb } from "../db.js";

export const MEDIA_BACKFILL_DEFAULT_LIMIT = 50;
export const MEDIA_BACKFILL_MAX_LIMIT = 200;

export interface MediaBackfillReport {
  scanned: number;
  releasesUpdated: number;
  imagesMirrored: number;
  /** Rows still needing backfill after this batch (full pending count on dryRun). */
  remaining: number;
  dryRun: boolean;
}

interface StoredMediaItem {
  type?: string;
  url: string;
  alt?: string;
  r2Key?: string;
}

/** Parse a release's stored media JSON into items with a string `url`. */
function parseStoredMedia(raw: string | null): StoredMediaItem[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((m): m is StoredMediaItem => m && typeof m.url === "string");
  } catch {
    return [];
  }
}

export async function runMediaBackfill(
  db: ReturnType<typeof createDb>,
  bucket: R2Bucket,
  opts: {
    sourceId?: string;
    limit: number;
    dryRun: boolean;
    /** Injectable for tests; forwarded to processMediaForR2. */
    fetchImpl?: typeof fetch;
    now?: () => string;
  },
): Promise<MediaBackfillReport> {
  // Heuristic SQL prefilter: a third-party http(s) media URL present, no `r2Key`
  // stamped yet. Cheap to evaluate; the per-row parse below is the real gate.
  const needsBackfill = and(
    sql`${releases.media} LIKE '%http%'`,
    sql`${releases.media} NOT LIKE '%r2Key%'`,
    eq(releases.suppressed, false),
    ...(opts.sourceId ? [eq(releases.sourceId, opts.sourceId)] : []),
  );

  const candidates = await db
    .select({ id: releases.id, sourceId: releases.sourceId, media: releases.media })
    .from(releases)
    .where(needsBackfill)
    .orderBy(desc(releases.publishedAt))
    .limit(opts.limit);

  const report: MediaBackfillReport = {
    scanned: candidates.length,
    releasesUpdated: 0,
    imagesMirrored: 0,
    remaining: 0,
    dryRun: opts.dryRun,
  };

  if (!opts.dryRun) {
    for (const row of candidates) {
      const filtered = filterJunkMedia(parseStoredMedia(row.media));
      if (filtered.length === 0) continue;
      // oxlint-disable-next-line no-await-in-loop -- bounded by `limit`; the helper bounds image concurrency internally
      const processed = await processMediaForR2(filtered, {
        db,
        bucket,
        sourceId: row.sourceId,
        releaseId: row.id,
        fetchImpl: opts.fetchImpl,
        now: opts.now,
      });
      const mirrored = processed.filter((p) => p.r2Key).length;
      // Only write when at least one image actually mirrored — a row where every
      // image failed its fetch/gate keeps its third-party URLs and stays a
      // candidate for a later retry (e.g. a transiently-down CDN).
      if (mirrored === 0) continue;
      // oxlint-disable-next-line no-await-in-loop
      await db
        .update(releases)
        .set({ media: JSON.stringify(processed) })
        .where(eq(releases.id, row.id));
      report.releasesUpdated++;
      report.imagesMirrored += mirrored;
    }
  }

  const [remainingRow] = await db.select({ c: count() }).from(releases).where(needsBackfill);
  report.remaining = Number(remainingRow?.c ?? 0);
  return report;
}
