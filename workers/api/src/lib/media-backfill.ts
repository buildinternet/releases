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
import { isGifUrl } from "@releases/adapters/media-classify.js";
import { processMediaForR2, type MediaTransformBinding } from "./media-ingest.js";
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

// ── GIF → MP4 transcode backfill (#1368) ─────────────────────────────────────

export const GIF_BACKFILL_DEFAULT_LIMIT = 25;
export const GIF_BACKFILL_MAX_LIMIT = 100;

export interface GifBackfillReport {
  /** Rows examined this batch. */
  scanned: number;
  /** Rows whose media JSON was rewritten with at least one transcoded MP4. */
  releasesUpdated: number;
  /** Individual GIF items transcoded to MP4. */
  gifsTranscoded: number;
  /** Rows still matching the candidate filter (full pending count on dryRun). */
  remaining: number;
  dryRun: boolean;
}

/**
 * A stored item still needs transcoding when it's a `.gif` source whose stamped
 * `r2Key` isn't already an `.mp4`. Covers both the never-mirrored case (no
 * `r2Key`) and a GIF previously mirrored verbatim as a `.gif` object.
 */
function gifNeedsTranscode(m: StoredMediaItem): boolean {
  return isGifUrl(m.url) && !(m.r2Key ?? "").toLowerCase().endsWith(".mp4");
}

/**
 * Operator-triggered backfill that transcodes already-ingested animated GIFs to
 * MP4 (`releases/<hash>.mp4`) and re-stamps their media `r2Key`, so historical
 * rows get the same small-MP4 treatment as new ingests (#1368). Re-runs the exact
 * ingest transcode (`processMediaForR2` with `transcodeGif`); the per-item fetch
 * follows beehiiv/Firecrawl `cdn-cgi/image` wrappers' `onerror=redirect` to the
 * raw GIF, so wrapper URLs transcode without special-casing.
 *
 * Candidate filter is `media LIKE '%.gif%' AND NOT LIKE '%.mp4%'`: a row drops out
 * once it carries any MP4, so the operator can loop on `remaining` to convergence.
 * Trade-off: a row mixing an untranscoded GIF with a pre-existing `.mp4` (e.g. a
 * native video) won't be re-selected — rare, and surfaced via the per-row logs.
 * Only gif items are processed (non-gif media is left untouched, so a transient
 * CDN failure can never strip an existing image `r2Key`).
 */
export async function runGifTranscodeBackfill(
  db: ReturnType<typeof createDb>,
  bucket: R2Bucket,
  mediaTransform: MediaTransformBinding,
  opts: {
    sourceId?: string;
    limit: number;
    dryRun: boolean;
    /** Injectable for tests; forwarded to processMediaForR2. */
    fetchImpl?: typeof fetch;
    now?: () => string;
  },
): Promise<GifBackfillReport> {
  const needsBackfill = and(
    sql`${releases.media} LIKE '%.gif%'`,
    sql`${releases.media} NOT LIKE '%.mp4%'`,
    eq(releases.suppressed, false),
    ...(opts.sourceId ? [eq(releases.sourceId, opts.sourceId)] : []),
  );

  const candidates = await db
    .select({ id: releases.id, sourceId: releases.sourceId, media: releases.media })
    .from(releases)
    .where(needsBackfill)
    .orderBy(desc(releases.publishedAt))
    .limit(opts.limit);

  const report: GifBackfillReport = {
    scanned: candidates.length,
    releasesUpdated: 0,
    gifsTranscoded: 0,
    remaining: 0,
    dryRun: opts.dryRun,
  };

  if (!opts.dryRun) {
    for (const row of candidates) {
      const items = parseStoredMedia(row.media);
      const todo = items.filter(gifNeedsTranscode);
      if (todo.length === 0) continue;
      // oxlint-disable-next-line no-await-in-loop -- bounded by `limit`; the helper bounds image concurrency internally
      const processed = await processMediaForR2(todo, {
        db,
        bucket,
        mediaTransform,
        transcodeGif: true,
        sourceId: row.sourceId,
        releaseId: row.id,
        fetchImpl: opts.fetchImpl,
        now: opts.now,
      });
      // Map only the items that actually produced an MP4 back onto the row. A
      // failed transcode leaves the original item untouched (no r2Key strip).
      const mp4ByUrl = new Map<string, string>();
      for (const p of processed) {
        if (p.r2Key && p.r2Key.toLowerCase().endsWith(".mp4")) mp4ByUrl.set(p.url, p.r2Key);
      }
      if (mp4ByUrl.size === 0) continue;
      const merged = items.map((m) => {
        const key = mp4ByUrl.get(m.url);
        // oxlint-disable-next-line no-map-spread -- copy-on-write: re-stamp only the transcoded gif item
        return key ? { ...m, type: "gif", r2Key: key } : m;
      });
      // oxlint-disable-next-line no-await-in-loop
      await db
        .update(releases)
        .set({ media: JSON.stringify(merged) })
        .where(eq(releases.id, row.id));
      report.releasesUpdated++;
      report.gifsTranscoded += mp4ByUrl.size;
    }
  }

  const [remainingRow] = await db.select({ c: count() }).from(releases).where(needsBackfill);
  report.remaining = Number(remainingRow?.c ?? 0);
  return report;
}
