/**
 * Shared batch-release ingest core, extracted from `postReleasesBatchHandler`
 * (#1946 phase 4, task 3) so a later D1 persister can call it in-process
 * without going through HTTP.
 *
 * Split in two:
 * - `ingestReleaseBatch` — the durable core: deny filter, scrape title-dedup,
 *   media R2 mirror + GIF transcode, chunked upsert (D1's 100 bind-param cap),
 *   cascade coverage clustering, total count. Everything here is either a
 *   write the caller needs reflected in the response, or a read needed to
 *   decide one.
 * - `runBatchIngestEffects` — the post-insert fire-and-forget extras: publish
 *   to the ReleaseHub DO, IndexNow ping, latest-cache invalidation, and
 *   embed + `embeddedAt` marking. These already tolerate failure independently
 *   (each has its own catch/logEvent), so they run concurrently via
 *   `Promise.allSettled` rather than sequentially.
 *
 * Request-shaped concerns (body parsing, `releases`-array validation, `mode`
 * validation → `enrichMode`) stay in the route handler — they're HTTP
 * boundary concerns, not ingest logic, and a future in-process caller won't
 * have an HTTP body to parse.
 */
import { eq, inArray, count } from "drizzle-orm";
import { releases, organizations, type ReleaseType } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../db.js";
import { RELEASE_URL_UPSERT, RELEASE_CONTENT_UPSERT } from "@releases/core-internal/release-upsert";
import { fetchEffectiveCategoryBySourceIds } from "@releases/core-internal/effective-category";
import { inferMonthOnlyDate } from "@buildinternet/releases-core/dates";
import { isPrereleaseVersion } from "@buildinternet/releases-core/prerelease";
import { computeVersionSort } from "@buildinternet/releases-core/version-sort";
import { computeContentSize } from "@buildinternet/releases-core/tokens";
import { sanitizeVersion } from "@releases/adapters/extract/shared.js";
import { getSourceMeta, filterByUrlDeny } from "@releases/adapters/feed.js";
import { dedupeByExistingTitle } from "@buildinternet/releases-core/title-dedup";
import { selectExistingReleaseKeys } from "./title-dedup.js";
import { processMediaForR2, selectExistingReleaseUrls } from "./media-ingest.js";
import { filterJunkMedia } from "@releases/rendering/media-filter.js";
import { normalizeMediaBind } from "./media-bind.js";
import { RELEASES_BATCH_CHUNK_SIZE, RELEASES_ID_IN_CHUNK_SIZE } from "./d1-limits.js";
import { clusterAndPersistCascades } from "./cluster-cascades.js";
import { invalidateLatestCache, type InvalidationEnv } from "./latest-cache.js";
import { publishReleaseEvents, type PublishEnv } from "../events/publish.js";
import type { InsertedReleaseRow } from "../events/build-event.js";
import { notifyIndexNowForSource, type IndexNowEnv } from "./indexnow.js";
import { resolveOrgSlug, resolveProductSlug } from "./slug-lookups.js";
import { buildEmbedConfig, type EmbedEnv } from "@releases/search/embed-config.js";
import { embedAndUpsertReleases } from "@releases/search/embed-releases.js";
import { logEvent } from "@releases/lib/log-event";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";
import type { MediaTransformBinding } from "./media-ingest.js";

export interface BatchReleaseInput {
  version?: string | null;
  title: string;
  content: string;
  url?: string | null;
  contentHash?: string;
  publishedAt?: string | null;
  media?: string | null;
  type?: ReleaseType;
  prerelease?: boolean;
}

export interface BatchIngestResult {
  inserted: number;
  total: number;
  insertedIds: string[];
  /** rows for the publish/IndexNow effects, coverage rows already filtered out */
  visiblePublishRows: InsertedReleaseRow[];
}

/**
 * Env slice used by `ingestReleaseBatch`. Kept in sync with the API worker's
 * `Env.Bindings` (see `../index.ts`) the same way `InvalidationEnv` /
 * `PublishEnv` / `IndexNowEnv` are.
 */
export interface BatchIngestEnv {
  FLAGS?: FlagshipBinding;
  SCRAPE_TITLE_DEDUP_DISABLED?: string;
  MEDIA?: R2Bucket;
  MEDIA_TRANSFORM?: MediaTransformBinding;
  MEDIA_GIF_TRANSCODE_ENABLED?: string;
}

/**
 * Env slice used by `runBatchIngestEffects` — a union of the effect helpers'
 * own env slices, plus the embed config env.
 */
export interface BatchEffectsEnv extends PublishEnv, IndexNowEnv, InvalidationEnv, EmbedEnv {
  // Typed loosely (matches the route's `Env.Bindings` Cloudflare `VectorizeIndex`)
  // and narrowed via cast at the call site below — see the note in
  // embedSourceSideEffect about why the cast is needed.
  RELEASES_INDEX: unknown;
}

/**
 * Durable core: deny filter, title dedup, media R2 mirror, chunked upsert,
 * cascade coverage clustering, total count.
 */
export async function ingestReleaseBatch(
  db: D1Db,
  env: BatchIngestEnv,
  src: Source,
  input: { releases: BatchReleaseInput[]; enrichMode: boolean },
): Promise<BatchIngestResult> {
  const enrichMode = input.enrichMode;
  let releasesInput = input.releases;

  // Defense-in-depth `feedUrlDeny` (#1335). The cron poll-fetch path drops
  // locale-suffixed translation dupes in-memory, but every managed-agent fetch
  // path — operator `admin source fetch`, scrape summary-only crawl delegation,
  // and the in-worker scrape pipeline — writes through this endpoint and would
  // otherwise bypass that filter (the MA worker re-derives URLs independently of
  // the in-memory filtered list). Applying it here at the write boundary means a
  // denied URL can't be ingested as an active release regardless of fetch path.
  const denyMeta = getSourceMeta(src);
  if (denyMeta.feedUrlDeny && denyMeta.feedUrlDeny.length > 0) {
    const filtered = filterByUrlDeny(releasesInput, denyMeta.feedUrlDeny);
    if (filtered.dropped > 0) {
      logEvent("info", {
        component: "sources-batch",
        event: "url-deny-filter-applied",
        sourceId: src.id,
        slug: src.slug,
        kept: filtered.kept.length,
        dropped: filtered.dropped,
        feedUrlDeny: denyMeta.feedUrlDeny,
      });
    }
    releasesInput = filtered.kept;
  }

  // Title-dedup for scrape sources (#1410): the discovery-worker scrape sweep and
  // the local backfill both write through this endpoint with synthesized anchor
  // URLs (`<page>#<slug>`); a backfill's heading-slug anchor (`#may-2026`) and a
  // re-fetch's slug(title) anchor for the SAME release don't collide under
  // UNIQUE(source_id, url), so the entry lands twice. Collapse by normalized title
  // (scrape-scoped; feed/github/appstore carry stable real URLs). Kill-switchable.
  // Skipped entirely in enrich mode (#1526): a deliberate content re-POST carries
  // the SAME title as the row it updates, so title-dedup would drop the very rows
  // the operator means to enrich; the URL upsert is the right discriminator there.
  if (src.type === "scrape" && releasesInput.length > 0 && !enrichMode) {
    const dedupDisabled = await flag(
      env.FLAGS,
      env.SCRAPE_TITLE_DEDUP_DISABLED,
      FLAGS.scrapeTitleDedupDisabled,
    );
    if (!dedupDisabled) {
      const existing = await selectExistingReleaseKeys(db, src.id);
      const deduped = dedupeByExistingTitle(releasesInput, existing.titleKeys, existing.urls);
      if (deduped.dropped > 0) {
        logEvent("info", {
          component: "sources-batch",
          event: "title-dedup-applied",
          sourceId: src.id,
          slug: src.slug,
          kept: deduped.kept.length,
          dropped: deduped.dropped,
        });
      }
      releasesInput = deduped.kept;
    }
  }

  // D1 caps prepared statements at 100 bound parameters — see
  // `./d1-limits.ts` for the math behind the chunk size.
  let inserted = 0;
  const publishRows: InsertedReleaseRow[] = [];
  // Parallel collection of fresh rows-with-content for changesets
  // clustering. We can't run the clusterer off `publishRows` because
  // those omit `content` (the publish payload doesn't need it).
  const clusterRows: Array<{ id: string; version: string | null; content: string }> = [];

  // Stamp denormalized category for category-feed seeks (#886).
  const effectiveCategory =
    (await fetchEffectiveCategoryBySourceIds(db, [src.id])).get(src.id) ?? null;

  // Ingest-time R2 media upload (#1177). When the `MEDIA` bucket is bound,
  // drop junk and mirror surviving images to `released-media` before insert
  // so reads resolve a same-origin `r2Url`. Sequential per release (the
  // helper bounds image concurrency within); fail-open. An unbound `MEDIA`
  // bucket => the agent-provided media JSON is stored verbatim, as today.
  const r2UploadEnabled = env.MEDIA != null;
  // GIF→MP4 ingest transcode (#1368): store ingested GIFs as small MP4s when the
  // transform binding is bound + the flag is on; off => GIFs mirror verbatim.
  const transcodeGif =
    env.MEDIA_TRANSFORM != null &&
    (await flag(env.FLAGS, env.MEDIA_GIF_TRANSCODE_ENABLED, FLAGS.mediaGifTranscodeEnabled));
  // Coerce array/object media to a JSON string so a non-primitive bind can't
  // 500 the chunked, non-transactional insert mid-batch. See media-bind.ts.
  const mediaJsonByIndex = releasesInput.map((r) => normalizeMediaBind(r.media));
  if (r2UploadEnabled) {
    // Skip releases whose URL already exists: RELEASE_URL_UPSERT never updates
    // the `media` column on conflict, so mirroring their images to R2 would
    // upload bytes the upsert immediately discards. In enrich mode (#1526) the
    // upsert DOES overwrite media, so existing URLs must be processed too —
    // skip the skip.
    const existingMediaUrls = enrichMode
      ? new Set<string>()
      : await selectExistingReleaseUrls(
          db,
          src.id,
          releasesInput.map((r) => r.url),
        );
    for (let i = 0; i < releasesInput.length; i++) {
      const rel = releasesInput[i]!;
      if (rel.url != null && existingMediaUrls.has(rel.url)) continue;
      const rawMedia = rel.media;
      if (!rawMedia) continue;
      let parsed: Array<{
        type: "image" | "video" | "gif";
        url: string;
        alt?: string;
        r2Key?: string;
      }>;
      try {
        parsed = JSON.parse(rawMedia);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed) || parsed.length === 0) continue;
      // oxlint-disable-next-line no-await-in-loop -- sequential per release; helper bounds image concurrency internally
      const processed = await processMediaForR2(
        filterJunkMedia(parsed.filter((m) => m && typeof m.url === "string")),
        {
          db,
          bucket: env.MEDIA!,
          sourceId: src.id,
          mediaTransform: env.MEDIA_TRANSFORM,
          transcodeGif,
        },
      );
      mediaJsonByIndex[i] = JSON.stringify(processed);
    }
  }

  for (let i = 0; i < releasesInput.length; i += RELEASES_BATCH_CHUNK_SIZE) {
    const chunk = releasesInput.slice(i, i + RELEASES_BATCH_CHUNK_SIZE).map((r, j) => {
      // LLM-driven agent fetches occasionally emit literal placeholders
      // ("<UNKNOWN>", "n/a", "none") instead of omitting the version.
      // The web frontend promotes a non-null version to the heading slot
      // and demotes title to a byline, so a placeholder leaks all the way
      // to the UI. Strip them here as a server-side safety net — the AI
      // extract path already calls `sanitizeVersion` on its own output.
      // Type-guard the JSON: sanitizeVersion calls .trim(), which would
      // throw on a number or object payload (the body type is the request
      // contract, not a runtime guarantee).
      const version = typeof r.version === "string" ? (sanitizeVersion(r.version) ?? null) : null;
      // Mirror the version type-guard: the helper expects a string, and a
      // non-string title would crash .match() and 500 the whole batch.
      const inferredPublishedAt = typeof r.title === "string" ? inferMonthOnlyDate(r.title) : null;
      const size = computeContentSize(r.content);
      return {
        sourceId: src.id,
        version,
        versionSort: computeVersionSort(version),
        type: r.type ?? "feature",
        title: r.title,
        content: r.content,
        url: r.url ?? null,
        contentHash: r.contentHash ?? null,
        contentChars: size.contentChars,
        contentTokens: size.contentTokens,
        publishedAt: r.publishedAt ?? inferredPublishedAt ?? null,
        prerelease: r.prerelease ?? isPrereleaseVersion(version),
        media: mediaJsonByIndex[i + j]!,
        effectiveCategory,
      };
    });
    // RETURNING is built here — not zipped against `chunk` — because
    // RELEASE_URL_UPSERT has a conditional WHERE clause that causes the
    // database to omit rows where the update didn't apply. The returned
    // rows are the authoritative set of affected ids + content.
    // In enrich mode (#1526) the clobbering RELEASE_CONTENT_UPSERT overwrites
    // content/media on a same-URL collision instead of fill-only.
    // oxlint-disable-next-line no-await-in-loop -- D1 chunked insert (100 bind param limit)
    const rows = await db
      .insert(releases)
      .values(chunk)
      .onConflictDoUpdate(enrichMode ? RELEASE_CONTENT_UPSERT : RELEASE_URL_UPSERT)
      .returning({
        id: releases.id,
        title: releases.title,
        version: releases.version,
        publishedAt: releases.publishedAt,
        media: releases.media,
        content: releases.content,
        contentChars: releases.contentChars,
        contentTokens: releases.contentTokens,
        type: releases.type,
      });
    inserted += rows.length;
    for (const r of rows) {
      const { content, ...publishRow } = r;
      publishRows.push(publishRow);
      clusterRows.push({ id: r.id, version: r.version, content });
    }
  }
  const insertedIds = publishRows.map((r) => r.id);

  // Detect changesets cascade rows and demote them to coverage so they
  // don't dominate the feed, broadcast on the live tail, or trigger an
  // IndexNow ping per row. Synchronous — we want coverage state visible
  // to the downstream waitUntils, not racing them.
  const cascadeResult = await clusterAndPersistCascades(db, clusterRows, {
    component: "sources-batch",
    sourceId: src.id,
  });
  const visiblePublishRows =
    cascadeResult.coverageIds.size > 0
      ? publishRows.filter((r) => !cascadeResult.coverageIds.has(r.id))
      : publishRows;

  const [{ n: total }] = await db
    .select({ n: count() })
    .from(releases)
    .where(eq(releases.sourceId, src.id));

  return { inserted, total, insertedIds, visiblePublishRows };
}

/**
 * The post-insert waitUntil extras: ReleaseHub publish, IndexNow, embed +
 * embeddedAt marking, latest-cache invalidation. Awaitable — the caller
 * decides whether to await inline or hand it to `waitUntil`.
 *
 * Publish/IndexNow/invalidate already tolerate failure independently (each
 * logs its own error internally), so they run concurrently via
 * `Promise.allSettled` rather than one blocking the others.
 */
export async function runBatchIngestEffects(
  db: D1Db,
  env: BatchEffectsEnv,
  src: Source,
  result: BatchIngestResult,
  opts?: { skipEmbed?: boolean; skipInvalidate?: boolean },
): Promise<void> {
  const { visiblePublishRows, insertedIds } = result;
  const tasks: Array<Promise<unknown>> = [];

  // Fire-and-forget publish to the ReleaseHub DO so subscribers (CLI
  // `tail -f`, the upcoming web live view, webhook delivery) see new
  // releases in real time. Coverage-side rows are excluded — they're
  // not shown in default feeds and shouldn't broadcast on the live tail
  // either.
  if (visiblePublishRows.length > 0) {
    tasks.push(
      publishReleaseEvents(env, {
        src: {
          name: src.name,
          slug: src.slug,
          orgId: src.orgId,
          sourceId: src.id,
          type: src.type,
          productId: src.productId,
        },
        inserted: visiblePublishRows,
      }),
    );
    if (!opts?.skipInvalidate) {
      tasks.push(
        invalidateLatestCache(env, {
          nReleases: visiblePublishRows.length,
          cause: src.id,
        }),
      );
    }
    tasks.push(
      notifyIndexNowForSource(
        env,
        {
          resolveOrgSlug: (id) => resolveOrgSlug(db, id),
          resolveProductSlug: (id) => resolveProductSlug(db, id),
        },
        {
          slug: src.slug,
          orgId: src.orgId,
          productId: src.productId,
          isHidden: src.isHidden,
          discovery: src.discovery,
        },
        visiblePublishRows.length,
      ),
    );
  }

  // Fire-and-forget: embed the rows we just wrote. Never fails the write —
  // embedAndUpsertReleases catches every error internally and logs to
  // console.
  if (!opts?.skipEmbed && insertedIds.length > 0) {
    tasks.push(
      (async () => {
        try {
          const embedConfig = await buildEmbedConfig(env);
          if (!embedConfig) return;
          // Load the rows back so we have full content, category, etc.
          // We need the org/product category for metadata filtering.
          const [orgRow] = src.orgId
            ? await db
                .select({ category: organizations.category })
                .from(organizations)
                .where(eq(organizations.id, src.orgId))
            : [{ category: null as string | null }];
          // D1 bind-param cap is 100; chunk the IN clause so we stay
          // well clear of the limit even if the caller posts a large
          // batch. See `./d1-limits.ts`.
          const rowsToEmbed: Array<{
            id: string;
            title: string;
            content: string;
            summary: string | null;
            version: string | null;
            publishedAt: string | null;
            sourceId: string;
            type: ReleaseType;
          }> = [];
          for (let i = 0; i < insertedIds.length; i += RELEASES_ID_IN_CHUNK_SIZE) {
            const slice = insertedIds.slice(i, i + RELEASES_ID_IN_CHUNK_SIZE);
            // oxlint-disable-next-line no-await-in-loop -- D1 chunked select (100 bind param limit for inArray)
            const rows = await db
              .select({
                id: releases.id,
                title: releases.title,
                content: releases.content,
                summary: releases.summary,
                version: releases.version,
                publishedAt: releases.publishedAt,
                sourceId: releases.sourceId,
                type: releases.type,
              })
              .from(releases)
              .where(inArray(releases.id, slice));
            rowsToEmbed.push(...rows);
          }

          const category = orgRow?.category ?? null;
          await embedAndUpsertReleases({
            // oxlint-disable-next-line no-map-spread -- copy-on-write required; r is a DB row
            releases: rowsToEmbed.map((r) => ({
              ...r,
              orgId: src.orgId,
              productId: src.productId,
              category,
            })),
            // See note in embedSourceSideEffect about the cast.
            vectorIndex:
              env.RELEASES_INDEX as unknown as import("@releases/search/vector-search.js").VectorizeIndex,
            embedConfig,
            onPersisted: async (ids) => {
              if (ids.length === 0) return;
              // Mark the rows as embedded. D1's 100 bind-param cap means
              // the embeddedAt SET + N IN-clause ids must total ≤100, so
              // we chunk IDs — see `./d1-limits.ts`.
              const now = new Date().toISOString();
              for (let i = 0; i < ids.length; i += RELEASES_ID_IN_CHUNK_SIZE) {
                const slice = ids.slice(i, i + RELEASES_ID_IN_CHUNK_SIZE);
                // oxlint-disable-next-line no-await-in-loop -- D1 chunked update (100 bind param limit)
                await db
                  .update(releases)
                  .set({ embeddedAt: now })
                  .where(inArray(releases.id, slice));
              }
            },
          });
        } catch (err) {
          logEvent("warn", {
            component: "sources-batch",
            event: "embed-side-effect-failed",
            err: err instanceof Error ? err : String(err),
          });
        }
      })(),
    );
  }

  await Promise.allSettled(tasks);
}
