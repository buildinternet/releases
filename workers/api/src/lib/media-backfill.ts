/**
 * R2 backfill for releases stored before ingest-time R2 mirroring was active
 * (or while the `MEDIA` bucket binding was unbound), so their `media` still
 * points at third-party URLs with no `r2Key`.
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
import { and, count, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { releases } from "@buildinternet/releases-core/schema";
import {
  CHROME_MEDIA_MARKERS,
  filterJunkMedia,
  SMALL_MEDIA_MARKERS,
} from "@releases/rendering/media-filter.js";
import { isGifUrl } from "@releases/adapters/media-classify.js";
import { detectInlineVideos, VIDEO_EMBED_HOST_HINTS } from "@releases/rendering/video-embed.js";
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

// ── Junk-media purge ─────────────────────────────────────────────────────────

export const JUNK_PURGE_DEFAULT_LIMIT = 200;
export const JUNK_PURGE_MAX_LIMIT = 1000;

export interface JunkPurgeReport {
  /** Rows examined this batch (matched the junk prefilter). */
  scanned: number;
  /** Rows whose stored `media[]` actually had junk removed + rewritten. */
  releasesUpdated: number;
  /** Total junk items dropped across all rows. */
  itemsRemoved: number;
  /**
   * Rows still matching the junk prefilter after this batch. Approximate: a row
   * where a marker appears inside a *real* URL never had anything to remove yet
   * still matches, so loop on `releasesUpdated > 0`, not `remaining === 0`.
   */
  remaining: number;
  dryRun: boolean;
}

/** Every junk URL marker, so the SQL prefilter can't drift from `isJunkMediaUrl`. */
const JUNK_MARKERS: readonly string[] = [...SMALL_MEDIA_MARKERS, ...CHROME_MEDIA_MARKERS];

/**
 * SQL prefilter: a stored `media` JSON string containing any known junk marker.
 * Cheap substring match to avoid scanning every row; the per-row
 * `filterJunkMedia` is the real gate (and also strips favicon/`data:` items,
 * which have no fixed marker, from any row this catches).
 */
function junkCandidateFilter(sourceId?: string): SQL | undefined {
  const hasMarker = or(...JUNK_MARKERS.map((m) => sql`${releases.media} LIKE ${`%${m}%`}`));
  return and(
    hasMarker,
    eq(releases.suppressed, false),
    ...(sourceId ? [eq(releases.sourceId, sourceId)] : []),
  );
}

/**
 * Strip decorative-chrome media (emoji sprites, CI-review badges, avatars,
 * favicons, `data:` URIs) from existing releases' stored `media[]` — the
 * cleanup companion to the ingest-time `filterJunkMedia` pre-filter, for rows
 * ingested before a marker existed. Unlike `runMediaBackfill` (which only
 * rewrites a row when an image mirrors), this rewrites whenever filtering
 * removes an item, so a media list that is *entirely* junk is cleared to `[]`.
 *
 * Idempotent: a cleaned row no longer matches the junk prefilter. Bounded by
 * `limit`; `dryRun` reports what *would* be removed without writing.
 */
export async function runJunkMediaPurge(
  db: ReturnType<typeof createDb>,
  opts: { sourceId?: string; limit: number; dryRun: boolean },
): Promise<JunkPurgeReport> {
  const filter = junkCandidateFilter(opts.sourceId);
  const candidates = await db
    .select({ id: releases.id, media: releases.media })
    .from(releases)
    .where(filter)
    .orderBy(desc(releases.publishedAt))
    .limit(opts.limit);

  const report: JunkPurgeReport = {
    scanned: candidates.length,
    releasesUpdated: 0,
    itemsRemoved: 0,
    remaining: 0,
    dryRun: opts.dryRun,
  };

  for (const row of candidates) {
    const original = parseStoredMedia(row.media);
    const filtered = filterJunkMedia(original);
    const removed = original.length - filtered.length;
    if (removed === 0) continue; // matched a marker inside a real URL — nothing to drop
    report.releasesUpdated++;
    report.itemsRemoved += removed;
    if (!opts.dryRun) {
      // oxlint-disable-next-line no-await-in-loop -- bounded by `limit`
      await db
        .update(releases)
        .set({ media: JSON.stringify(filtered) })
        .where(eq(releases.id, row.id));
    }
  }

  const [remainingRow] = await db.select({ c: count() }).from(releases).where(filter);
  report.remaining = Number(remainingRow?.c ?? 0);
  return report;
}

// ── Inline hosted-video backfill (#1549 retrofit) ────────────────────────────

export const VIDEO_BACKFILL_DEFAULT_LIMIT = 50;
export const VIDEO_BACKFILL_MAX_LIMIT = 200;

export interface VideoBackfillReport {
  /** Rows examined this batch. */
  scanned: number;
  /** Rows whose media[] gained at least one new video item. */
  releasesUpdated: number;
  /** Individual `type:"video"` items appended across all rows. */
  videosAppended: number;
  /** Rows still matching the candidate filter (full pending count on dryRun). */
  remaining: number;
  dryRun: boolean;
}

/**
 * SQL prefilter: a release body that references a known video-embed provider
 * host. Cheap substring match; `detectInlineVideos` is the real per-row gate.
 * The `remaining` count after a write is approximate — a row whose every embed
 * was already promoted still matches this LIKE — so the operator should loop on
 * `releasesUpdated > 0`, not `remaining === 0`.
 */
function videoCandidateFilter(sourceId?: string, releaseId?: string): SQL | undefined {
  // Derived from the detector's own host table (`VIDEO_EMBED_HOST_HINTS`) so the
  // prefilter can't narrow below detection when a provider/host is added.
  const hostLike = or(
    ...VIDEO_EMBED_HOST_HINTS.map((h) => sql`${releases.content} LIKE ${`%${h}%`}`),
  );
  return and(
    hostLike,
    eq(releases.suppressed, false),
    ...(releaseId ? [eq(releases.id, releaseId)] : []),
    ...(sourceId ? [eq(releases.sourceId, sourceId)] : []),
  );
}

/**
 * Retrofit the inline hosted-video card (#1549) onto releases ingested before
 * that ingest hook existed. For each candidate release this re-runs the exact
 * ingest detection (`detectInlineVideos` → oEmbed poster/title/watch-URL),
 * mirrors the poster via `processMediaForR2`, and APPENDS the resulting
 * `type:"video"` item(s) to the existing `media[]` — preserving the row's
 * `rel_` id, its hero image, and every other media item. Idempotent: a video
 * already present (matched by `linkUrl`) is skipped, so re-running adds nothing.
 *
 * Mirrors the `runMediaBackfill` shape: bounded by `limit`, `dryRun` reports the
 * candidate count without writing, scope by `releaseId` (single) or `sourceId`
 * (sweep). Fail-open per release — an unresolvable embed yields no item and the
 * row is left untouched. `fetchImpl` is injectable so tests never hit oEmbed or
 * the poster CDN.
 */
export async function runVideoBackfill(
  db: ReturnType<typeof createDb>,
  bucket: R2Bucket,
  opts: {
    sourceId?: string;
    releaseId?: string;
    limit: number;
    dryRun: boolean;
    /** Injectable for tests; forwarded to detectInlineVideos + processMediaForR2. */
    fetchImpl?: typeof fetch;
    now?: () => string;
  },
): Promise<VideoBackfillReport> {
  const filter = videoCandidateFilter(opts.sourceId, opts.releaseId);

  const candidates = await db
    .select({
      id: releases.id,
      sourceId: releases.sourceId,
      content: releases.content,
      media: releases.media,
    })
    .from(releases)
    .where(filter)
    .orderBy(desc(releases.publishedAt))
    .limit(opts.limit);

  const report: VideoBackfillReport = {
    scanned: candidates.length,
    releasesUpdated: 0,
    videosAppended: 0,
    remaining: 0,
    dryRun: opts.dryRun,
  };

  if (!opts.dryRun) {
    for (const row of candidates) {
      const existing = parseStoredMedia(row.media);
      // Dedup against video items already present (by watch URL = linkUrl).
      const haveLinks = new Set(
        existing
          .map((m) => (m as { linkUrl?: string }).linkUrl)
          .filter((l): l is string => typeof l === "string" && l.length > 0),
      );
      // oxlint-disable-next-line no-await-in-loop -- bounded by `limit`; helper bounds oEmbed concurrency internally
      const detected = await detectInlineVideos(row.content, { fetchImpl: opts.fetchImpl });
      const fresh = detected.filter((v) => !haveLinks.has(v.linkUrl));
      if (fresh.length === 0) continue;

      // Mirror each new poster to R2 (same path as ingest), then append. A
      // poster that fails its fetch/gate keeps its third-party URL (fail-open).
      // oxlint-disable-next-line no-await-in-loop -- bounded by `limit`; helper bounds image concurrency internally
      const mirrored = await processMediaForR2(filterJunkMedia(fresh), {
        db,
        bucket,
        sourceId: row.sourceId,
        releaseId: row.id,
        fetchImpl: opts.fetchImpl,
        now: opts.now,
      });
      // `filterJunkMedia` could in principle drop a poster (it won't for a real
      // oEmbed thumbnail); guard against an empty append so we don't write a
      // no-op + bump the counter.
      if (mirrored.length === 0) continue;

      const merged = [...existing, ...mirrored];
      // oxlint-disable-next-line no-await-in-loop
      await db
        .update(releases)
        .set({ media: JSON.stringify(merged) })
        .where(eq(releases.id, row.id));
      report.releasesUpdated++;
      report.videosAppended += mirrored.length;
    }
  }

  const [remainingRow] = await db.select({ c: count() }).from(releases).where(filter);
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
