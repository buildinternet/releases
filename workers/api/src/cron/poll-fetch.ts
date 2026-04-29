import { eq, and, or, sql, isNull, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  sources,
  releases,
  fetchLog,
  sourceChangelogFiles,
  sourceChangelogChunks,
  knowledgePages,
} from "@buildinternet/releases-core/schema";
import { countTokensSafe } from "@buildinternet/releases-core/tokens";
import { notDisabled } from "../queries/shared.js";
import type { Source } from "@buildinternet/releases-core/schema";
import {
  headCheckUrl,
  bodyHashCheck,
  fetchAndParseFeed,
  getSourceMeta,
  FEED_4XX_INVALIDATE_THRESHOLD,
  CLEARED_FEED_FIELDS,
} from "@releases/adapters/feed.js";
import type { SourceMetadata, ChangeStatus } from "@releases/adapters/feed.js";
import { loadFetchQuirks, type FetchQuirk } from "@releases/ai-internal/playbook";
import { FeedHttpError } from "@releases/lib/errors";
import { contentHash } from "@releases/adapters/content-hash";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import type { RawRelease } from "@releases/adapters/types.js";
import { normalizeMediaUrl } from "@releases/rendering/media-url.js";
import { embedAndUpsertChangelogFile } from "@releases/search/embed-changelog-pipeline.js";
import { buildEmbedConfig } from "../lib/embed-config.js";
import { runWithConcurrency } from "../lib/concurrency.js";
import type { VectorizeIndex } from "@releases/search/vector-search.js";
import { embedAndUpsertReleases } from "@releases/search/embed-releases.js";
import { RELEASES_ID_IN_CHUNK_SIZE } from "../lib/d1-limits.js";
import { publishReleaseEvents } from "../events/publish.js";
import { invalidateLatestCache } from "../lib/latest-cache.js";
import type { InvalidationEnv } from "../lib/latest-cache.js";
import type { InsertedReleaseRow } from "../events/build-event.js";

// ── Tier intervals (hours) ──

type PollTier = "normal" | "low";

const TIER_INTERVALS: Record<PollTier, number> = {
  normal: 4,
  low: 24,
};

const POLL_CONCURRENCY = 5;
const FETCH_CONCURRENCY = 3;

// ── Main entry point ──

export async function pollAndFetch(
  env: FetchOneEnv &
    InvalidationEnv & {
      DB: D1Database;
      CRON_ENABLED?: string;
      SCRAPE_CHANGE_DETECT_ENABLED?: string;
    },
): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    console.log("[cron] Disabled via CRON_ENABLED=false, skipping");
    return;
  }

  const db = drizzle(env.DB);
  const now = new Date();
  const changeDetectEnabled = env.SCRAPE_CHANGE_DETECT_ENABLED === "true";

  // Query sources due for a poll
  const dueSources = await queryDueSources(db, now, { changeDetectEnabled });
  if (dueSources.length === 0) return;

  console.log(`[cron] Polling ${dueSources.length} due source(s)`);

  // Pre-load playbook notes once per distinct org so `pollOne`'s fetchQuirks
  // lookup doesn't fan out into N queries. Empty when the flag is off.
  const playbookNotesByOrg = changeDetectEnabled
    ? await loadPlaybookNotesForSources(db, dueSources)
    : new Map<string, string | null>();

  // Poll phase: HEAD checks
  const pollResults = await runWithConcurrency(dueSources, POLL_CONCURRENCY, async (source) => {
    return pollOne(db, source, now, {
      changeDetectEnabled,
      playbookNotes: source.orgId ? (playbookNotesByOrg.get(source.orgId) ?? null) : null,
    });
  });

  // Fetch phase: fetch changed feed/github sources, plus scrape sources
  // that have a discovered feed (their fetchOne path prefers that feed over
  // crawl+AI, so cost is identical to a native feed source).
  const fetchable = pollResults
    .filter((r) => r.changed)
    .map((r) => r.source)
    .filter(
      (s) =>
        s.type === "feed" ||
        s.type === "github" ||
        (s.type === "scrape" && getSourceMeta(s).feedUrl != null),
    );

  // Aggregate insert count across the whole cron run so the latest-cache
  // invalidator fires once per cron invocation, not once per source.
  let totalInserted = 0;
  let lastInsertingSource: string | undefined;

  if (fetchable.length > 0) {
    console.log(`[cron] Fetching ${fetchable.length} changed source(s)`);
    const results = await runWithConcurrency(fetchable, FETCH_CONCURRENCY, async (source) => {
      const r = await fetchOne(db, source, env);
      if (r.releasesInserted > 0) {
        totalInserted += r.releasesInserted;
        lastInsertingSource = source.id;
      }
      return r;
    });
    void results;
  }

  if (totalInserted > 0) {
    await invalidateLatestCache(env, {
      nReleases: totalInserted,
      sourceId: lastInsertingSource ?? "cron",
    });
  }

  const changedScrape = pollResults
    .filter((r) => r.changed)
    .map((r) => r.source)
    .filter((s) => s.type === "agent" || (s.type === "scrape" && getSourceMeta(s).feedUrl == null));
  if (changedScrape.length > 0) {
    console.log(`[cron] ${changedScrape.length} scrape/agent source(s) flagged for pickup`);
  }
}

// ── Query due sources ──

export async function queryDueSources(
  db: ReturnType<typeof drizzle>,
  now: Date,
  opts?: { changeDetectEnabled?: boolean },
): Promise<Source[]> {
  const notPaused = sql`${sources.fetchPriority} != 'paused'`;
  // Include sources that have a feed URL OR are GitHub type (GitHub sources
  // don't store a feedUrl — they use the GitHub releases API directly).
  // Behind SCRAPE_CHANGE_DETECT_ENABLED (#517), also include scrape/agent
  // sources with no feedUrl — `pollOne` routes those to a detector from the
  // playbook's `fetchQuirks` (unreliable class is a no-op, so the widened
  // filter doesn't explode poll volume).
  const pollable = opts?.changeDetectEnabled
    ? sql`(json_extract(${sources.metadata}, '$.feedUrl') IS NOT NULL OR ${sources.type} = 'github' OR ${sources.type} IN ('scrape','agent'))`
    : sql`(json_extract(${sources.metadata}, '$.feedUrl') IS NOT NULL OR ${sources.type} = 'github')`;

  // Build OR conditions for each tier using sql template to avoid enum type issues
  const tierConditions = (Object.keys(TIER_INTERVALS) as PollTier[]).map((tier) => {
    const hours = TIER_INTERVALS[tier];
    const cutoff = new Date(now.getTime() - hours * 3600_000).toISOString();
    return and(
      sql`${sources.fetchPriority} = ${tier}`,
      or(isNull(sources.lastPolledAt), sql`${sources.lastPolledAt} < ${cutoff}`),
    );
  });

  return db
    .select()
    .from(sources)
    .where(and(notDisabled, pollable, notPaused, or(...tierConditions)));
}

// ── Poll one source ──

interface PollResult {
  source: Source;
  changed: boolean;
}

/**
 * Batch-load playbook notes for every distinct org represented in `sourceLike`.
 * Returns a map keyed by `orgId`; orgs with no playbook row are absent from
 * the map. Accepts any row shape with an `orgId` field so callers don't need
 * to materialize a full `Source` to use it.
 */
export async function loadPlaybookNotesForSources(
  db: ReturnType<typeof drizzle>,
  sourceLike: ReadonlyArray<{ orgId: string | null }>,
): Promise<Map<string, string | null>> {
  const orgIds = [...new Set(sourceLike.map((s) => s.orgId).filter((id): id is string => !!id))];
  const result = new Map<string, string | null>();
  if (orgIds.length === 0) return result;

  // D1 caps prepared statements at 100 bound parameters; chunk the IN list.
  for (let i = 0; i < orgIds.length; i += RELEASES_ID_IN_CHUNK_SIZE) {
    const slice = orgIds.slice(i, i + RELEASES_ID_IN_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- D1 chunked select (100 bind param limit)
    const rows = await db
      .select({ orgId: knowledgePages.orgId, notes: knowledgePages.notes })
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "playbook"), inArray(knowledgePages.orgId, slice)));
    for (const row of rows) {
      if (row.orgId) result.set(row.orgId, row.notes);
    }
  }
  return result;
}

export async function pollOne(
  db: ReturnType<typeof drizzle>,
  source: Source,
  now: Date,
  opts?: { changeDetectEnabled?: boolean; playbookNotes?: string | null },
): Promise<PollResult> {
  const nowIso = now.toISOString();
  const meta = getSourceMeta(source);

  // GitHub sources don't have feeds to HEAD-check — mark as changed so
  // the fetch phase always runs (dedup happens at the DB insert level)
  if (source.type === "github") {
    await db
      .update(sources)
      .set({ lastPolledAt: nowIso, changeDetectedAt: nowIso })
      .where(eq(sources.id, source.id));
    return { source, changed: true };
  }

  // Scrape-no-feed / agent: route via the playbook's fetchQuirks entry.
  // The flag gates both this branch and the pollable filter that admitted
  // the source; with the flag off, queryDueSources wouldn't have returned it.
  if (!meta.feedUrl && (source.type === "scrape" || source.type === "agent")) {
    if (!opts?.changeDetectEnabled) {
      await db.update(sources).set({ lastPolledAt: nowIso }).where(eq(sources.id, source.id));
      return { source, changed: false };
    }
    return pollScrapeOrAgentByQuirk(db, source, meta, now, opts.playbookNotes ?? null);
  }

  if (!meta.feedUrl) {
    await db.update(sources).set({ lastPolledAt: nowIso }).where(eq(sources.id, source.id));
    return { source, changed: false };
  }

  try {
    const result = await headCheckUrl(meta.feedUrl, {
      etag: meta.feedEtag,
      lastModified: meta.feedLastModified,
      contentLength: meta.feedContentLength,
    });

    // Update stored header values in metadata
    const metaUpdates: Partial<SourceMetadata> = {};
    if (result.etag) metaUpdates.feedEtag = result.etag;
    if (result.lastModified) metaUpdates.feedLastModified = result.lastModified;
    if (result.contentLength) metaUpdates.feedContentLength = result.contentLength;

    const updates: Record<string, unknown> = { lastPolledAt: nowIso };

    if (Object.keys(metaUpdates).length > 0) {
      const merged = { ...meta, ...metaUpdates };
      updates.metadata = JSON.stringify(merged);
    }

    const changed = result.status === "changed" || result.status === "unknown";
    if (changed) {
      updates.changeDetectedAt = nowIso;
    }

    await db.update(sources).set(updates).where(eq(sources.id, source.id));
    console.log(`[cron] Poll ${source.slug}: ${result.status} (${result.responseMs}ms)`);

    return { source, changed };
  } catch (err) {
    // Don't let one source failure stop the whole cron
    console.error(`[cron] Poll error for ${source.slug}: ${err}`);
    await db.update(sources).set({ lastPolledAt: nowIso }).where(eq(sources.id, source.id));
    return { source, changed: false };
  }
}

/**
 * Change-detector branch for scrape-no-feed and agent sources. Routes via
 * the playbook's `fetchQuirks[source.slug]` entry (#516 schema):
 *
 *   etag / content-length → `headCheckUrl` against the page URL with
 *                           `page*` validators stored in metadata.
 *   body-hash             → GET + SHA-256 against `pageContentHash`.
 *   unreliable            → no-op; Phase 3 force-drain cron handles these.
 *   absent                → no-op; source is stranded until populated.
 *
 * On a detected change the function sets `changeDetectedAt` (the scrape-
 * agent sweep cron then drains it) and persists fresh validators in
 * metadata. Always logs `detector=<x> outcome=<unchanged|changed|error>`
 * so the poll-and-fetch Workflow step-level view stays the single source
 * of truth for what happened on this cron tick.
 */
async function pollScrapeOrAgentByQuirk(
  db: ReturnType<typeof drizzle>,
  source: Source,
  meta: SourceMetadata,
  now: Date,
  playbookNotes: string | null,
): Promise<PollResult> {
  const nowIso = now.toISOString();
  const start = Date.now();
  const quirk = loadFetchQuirks(playbookNotes, source.slug);

  const logOutcome = (
    detector: FetchQuirk["changeDetector"] | "none",
    outcome: "unchanged" | "changed" | "error" | "skipped",
    extra?: string,
  ) => {
    const durationMs = Date.now() - start;
    console.log(
      `[cron] Poll ${source.slug}: detector=${detector} outcome=${outcome} durationMs=${durationMs}${extra ? ` ${extra}` : ""}`,
    );
  };

  // Persist a detector outcome: merge any new validators into metadata, set
  // `changeDetectedAt` when the probe detected a change, and always bump
  // `lastPolledAt`. Returns the `changed` flag the caller threads into the
  // PollResult.
  const persistOutcome = async (
    metaUpdates: Partial<SourceMetadata>,
    status: ChangeStatus,
  ): Promise<boolean> => {
    const changed = status === "changed" || status === "unknown";
    const updates: Record<string, unknown> = { lastPolledAt: nowIso };
    if (Object.keys(metaUpdates).length > 0) {
      updates.metadata = JSON.stringify({ ...meta, ...metaUpdates });
    }
    if (changed) updates.changeDetectedAt = nowIso;
    await db.update(sources).set(updates).where(eq(sources.id, source.id));
    return changed;
  };

  if (!quirk || quirk.changeDetector === "unreliable") {
    await db.update(sources).set({ lastPolledAt: nowIso }).where(eq(sources.id, source.id));
    logOutcome(quirk?.changeDetector ?? "none", "skipped");
    return { source, changed: false };
  }

  const probeUrl = quirk.changeProbeUrl ?? source.url;
  const detector = quirk.changeDetector;

  try {
    let metaUpdates: Partial<SourceMetadata>;
    let status: ChangeStatus;

    switch (detector) {
      case "body-hash": {
        const result = await bodyHashCheck(probeUrl, meta.pageContentHash);
        metaUpdates = {};
        if (result.contentHash) metaUpdates.pageContentHash = result.contentHash;
        status = result.status;
        break;
      }
      // etag + content-length both share `headCheckUrl` — the detector name
      // is really a hint about *which* header the source offers reliably,
      // not a different probe.
      case "etag":
      case "content-length": {
        const result = await headCheckUrl(probeUrl, {
          etag: meta.pageEtag,
          lastModified: meta.pageLastModified,
          contentLength: meta.pageContentLength,
        });
        metaUpdates = {};
        if (result.etag) metaUpdates.pageEtag = result.etag;
        if (result.lastModified) metaUpdates.pageLastModified = result.lastModified;
        if (result.contentLength) metaUpdates.pageContentLength = result.contentLength;
        status = result.status;
        break;
      }
    }

    const changed = await persistOutcome(metaUpdates, status);
    logOutcome(detector, status === "changed" ? "changed" : "unchanged");
    return { source, changed };
  } catch (err) {
    await db.update(sources).set({ lastPolledAt: nowIso }).where(eq(sources.id, source.id));
    logOutcome(detector, "error", `err="${err instanceof Error ? err.message : err}"`);
    return { source, changed: false };
  }
}

// ── Fetch one source ──

export interface FetchOneResult {
  releasesFound: number;
  releasesInserted: number;
  durationMs: number;
  status: "success" | "no_change" | "error" | "dry_run";
  error?: string;
  /**
   * IDs of newly-inserted release rows (empty when nothing changed).
   * Populated so callers that opt out of the inline embed / changelog-refresh
   * side-effects (`opts.skipSideEffects`) can drive those steps themselves.
   */
  insertedIds?: string[];
}

export const DEFAULT_FETCH_MAX_ENTRIES = 200;

export interface FetchOneEnv {
  GITHUB_TOKEN?: string;
  /**
   * Optional Vectorize bindings for semantic-search side effects. Typed as
   * `unknown` because the workers-types `VectorizeIndex` declares a stricter
   * metadata value type than the runtime-agnostic interface in
   * `@releases/search/vector-search.js`. Identical at runtime but the variance
   * prevents structural assignment; helpers below cast at the call site.
   */
  RELEASES_INDEX?: unknown;
  CHANGELOG_CHUNKS_INDEX?: unknown;
  EMBEDDING_PROVIDER?: string;
  VOYAGE_API_KEY?: { get(): Promise<string> };
  OPENAI_API_KEY?: { get(): Promise<string> };
  RELEASE_HUB?: DurableObjectNamespace;
  WEBHOOK_DELIVERY_QUEUE?: Queue<unknown>;
  DB?: D1Database;
}

export async function fetchOne(
  db: ReturnType<typeof drizzle>,
  source: Source,
  env: FetchOneEnv,
  opts?: {
    sessionId?: string;
    dryRun?: boolean;
    maxEntries?: number;
    /**
     * Skip the inline embed + CHANGELOG-refresh side-effects. Used by the
     * Workflows path (#486) so those steps can be retried independently.
     * When true, `insertedIds` is populated on success.
     */
    skipSideEffects?: boolean;
  },
): Promise<FetchOneResult> {
  const start = Date.now();
  const meta = getSourceMeta(source);
  const sessionId = opts?.sessionId ?? null;
  const dryRun = opts?.dryRun ?? false;
  const maxEntries = opts?.maxEntries ?? DEFAULT_FETCH_MAX_ENTRIES;
  const skipSideEffects = opts?.skipSideEffects ?? false;

  try {
    let rawReleases: RawRelease[];

    if (source.type === "github") {
      rawReleases = await fetchGitHub(source, env.GITHUB_TOKEN);
    } else {
      if (!meta.feedUrl || !meta.feedType) {
        console.warn(`[cron] Fetch ${source.slug}: missing feedUrl or feedType, skipping`);
        const dur = Date.now() - start;
        await db
          .insert(fetchLog)
          .values({
            sourceId: source.id,
            sessionId,
            releasesFound: 0,
            releasesInserted: 0,
            durationMs: dur,
            status: "error",
            error: "Missing feedUrl or feedType in source metadata",
          })
          .catch(() => {});
        return {
          releasesFound: 0,
          releasesInserted: 0,
          durationMs: dur,
          status: "error",
          error: "Missing feedUrl or feedType in source metadata",
        };
      }
      const conditionalHeaders: Record<string, string> = {};
      if (meta.feedEtag) conditionalHeaders["If-None-Match"] = meta.feedEtag;
      if (meta.feedLastModified) conditionalHeaders["If-Modified-Since"] = meta.feedLastModified;

      const result = await fetchAndParseFeed(
        meta.feedUrl,
        meta.feedType as "rss" | "atom" | "jsonfeed",
        { maxEntries },
        Object.keys(conditionalHeaders).length > 0 ? conditionalHeaders : undefined,
      );
      rawReleases = result.releases;

      // Dry-run is a pure probe — skip persisting new etag/lastModified so a
      // follow-up real fetch sees the same upstream state the dry-run saw.
      if (!dryRun) {
        const metaUpdates: Partial<SourceMetadata> = {};
        if (result.etag) metaUpdates.feedEtag = result.etag;
        if (result.lastModified) metaUpdates.feedLastModified = result.lastModified;
        if (result.contentLength) metaUpdates.feedContentLength = result.contentLength;
        if (meta.feed4xxStreak) metaUpdates.feed4xxStreak = undefined;
        if (Object.keys(metaUpdates).length > 0) {
          const merged = { ...meta, ...metaUpdates };
          await db
            .update(sources)
            .set({ metadata: JSON.stringify(merged) })
            .where(eq(sources.id, source.id));
        }
      }
    }

    if (dryRun) {
      const dur = Date.now() - start;
      await db.insert(fetchLog).values({
        sourceId: source.id,
        sessionId,
        releasesFound: rawReleases.length,
        releasesInserted: 0,
        durationMs: dur,
        status: "dry_run",
      });
      console.log(`[cron] Fetch ${source.slug}: dry-run (${rawReleases.length} found, ${dur}ms)`);
      return {
        releasesFound: rawReleases.length,
        releasesInserted: 0,
        durationMs: dur,
        status: "dry_run" as const,
      };
    }

    if (rawReleases.length === 0) {
      const newNoChange = (source.consecutiveNoChange ?? 0) + 1;
      const backoffHours = Math.min(Math.pow(2, newNoChange - 1), 48);
      const nextFetch = new Date(Date.now() + backoffHours * 3600_000).toISOString();
      await Promise.all([
        db.insert(fetchLog).values({
          sourceId: source.id,
          sessionId,
          releasesFound: 0,
          releasesInserted: 0,
          durationMs: Date.now() - start,
          status: "no_change",
        }),
        db
          .update(sources)
          .set({
            consecutiveNoChange: newNoChange,
            consecutiveErrors: 0,
            nextFetchAfter: nextFetch,
            changeDetectedAt: null,
          })
          .where(eq(sources.id, source.id)),
      ]);
      const dur = Date.now() - start;
      console.log(`[cron] Fetch ${source.slug}: no changes (${dur}ms)`);
      return {
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: dur,
        status: "no_change" as const,
      };
    }

    const rows = rawReleases.map((raw) => ({
      sourceId: source.id,
      version: raw.version ?? null,
      title: raw.title,
      content: raw.content,
      url: raw.url ?? null,
      contentHash: contentHash(raw),
      publishedAt: raw.publishedAt?.toISOString() ?? null,
      // Unwrap Next.js/Vercel image optimizer URLs so downstream R2 upload
      // and direct rendering both see the underlying CDN asset.
      media: JSON.stringify(
        // oxlint-disable-next-line no-map-spread -- copy-on-write required; m is an adapter-returned object
        (raw.media ?? []).map((m) => ({ ...m, url: normalizeMediaUrl(m.url) })),
      ),
    }));

    let inserted = 0;
    const publishRows: InsertedReleaseRow[] = [];
    for (let i = 0; i < rows.length; i += 5) {
      const chunk = rows.slice(i, i + 5);
      // Build publish rows from the RETURNING set (not zipped against
      // `chunk`) because onConflictDoNothing skips conflicting rows and
      // RETURNING omits them, so index alignment would drift.
      // oxlint-disable-next-line no-await-in-loop -- D1 chunked insert (100 bind param limit)
      const result = await db.insert(releases).values(chunk).onConflictDoNothing().returning({
        id: releases.id,
        title: releases.title,
        version: releases.version,
        publishedAt: releases.publishedAt,
        media: releases.media,
      });
      inserted += result.length;
      for (const r of result) publishRows.push(r);
    }
    const insertedIds = publishRows.map((r) => r.id);

    if (publishRows.length > 0 && env.RELEASE_HUB) {
      await publishReleaseEvents(
        {
          RELEASE_HUB: env.RELEASE_HUB,
          WEBHOOK_DELIVERY_QUEUE: env.WEBHOOK_DELIVERY_QUEUE,
          DB: env.DB,
        },
        {
          src: { name: source.name, slug: source.slug, orgId: source.orgId, sourceId: source.id },
          inserted: publishRows,
        },
      );
    }

    // Embed newly-inserted releases as a best-effort side effect. Failure
    // never aborts the fetch. Runs inline rather than in waitUntil because
    // fetchOne is already inside cron / a waitUntil boundary at the callers.
    // Workflows path skips this and drives embed from a separate step.
    if (!skipSideEffects && insertedIds.length > 0 && env.RELEASES_INDEX) {
      try {
        await embedReleasesForSource(db, source, insertedIds, env);
      } catch (err) {
        console.warn(
          `[cron] release embed failed for ${source.slug}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await Promise.all([
      db.insert(fetchLog).values({
        sourceId: source.id,
        sessionId,
        releasesFound: rawReleases.length,
        releasesInserted: inserted,
        durationMs: Date.now() - start,
        status: inserted > 0 ? "success" : "no_change",
      }),
      db
        .update(sources)
        .set({
          lastFetchedAt: new Date().toISOString(),
          consecutiveNoChange: 0,
          consecutiveErrors: 0,
          nextFetchAfter: null,
          changeDetectedAt: null,
        })
        .where(eq(sources.id, source.id)),
    ]);

    // Refresh canonical CHANGELOG file for GitHub sources (mirrors CLI fetch step
    // in src/cli/commands/fetch.ts). Never fail the outer fetch if this errors.
    // Workflows path skips this and drives refresh + embed from separate steps.
    if (!skipSideEffects && source.type === "github") {
      try {
        await refreshChangelogFile(db, source, env.GITHUB_TOKEN, env);
      } catch (err) {
        console.warn(
          `[cron] Changelog refresh failed for ${source.slug}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const dur = Date.now() - start;
    console.log(`[cron] Fetch ${source.slug}: ${inserted} new (${dur}ms)`);
    return {
      releasesFound: rawReleases.length,
      releasesInserted: inserted,
      durationMs: dur,
      status: inserted > 0 ? ("success" as const) : ("no_change" as const),
      insertedIds,
    };
  } catch (err) {
    console.error(`[cron] Fetch error for ${source.slug}: ${err}`);

    await db
      .insert(fetchLog)
      .values({
        sourceId: source.id,
        sessionId,
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: Date.now() - start,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      })
      .catch(() => {});

    // 4xx on the stored feedUrl: track it via feed4xxStreak rather than the
    // generic consecutiveErrors backoff. Backoff would push the next retry
    // out by hours and slow self-healing — we'd rather keep the normal cron
    // cadence until the streak hits the invalidation threshold.
    if (err instanceof FeedHttpError) {
      const streak = (meta.feed4xxStreak ?? 0) + 1;
      if (streak >= FEED_4XX_INVALIDATE_THRESHOLD) {
        console.warn(
          `[cron] Feed URL invalidated for ${source.slug} after ${streak} consecutive 4xx (${err.status}) — clearing for rediscovery`,
        );
        const cleared = { ...meta, ...CLEARED_FEED_FIELDS, noFeedFound: false };
        await db
          .update(sources)
          .set({
            metadata: JSON.stringify(cleared),
            consecutiveErrors: 0,
            nextFetchAfter: null,
          })
          .where(eq(sources.id, source.id))
          .catch(() => {});
      } else {
        const merged = { ...meta, feed4xxStreak: streak };
        await db
          .update(sources)
          .set({ metadata: JSON.stringify(merged) })
          .where(eq(sources.id, source.id))
          .catch(() => {});
      }
      return {
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: Date.now() - start,
        status: "error" as const,
        error: err.message,
      };
    }

    const newErrors = (source.consecutiveErrors ?? 0) + 1;
    const errorBackoffHours = Math.min(Math.pow(2, newErrors - 1), 72);
    const nextFetch = new Date(Date.now() + errorBackoffHours * 3600_000).toISOString();
    await db
      .update(sources)
      .set({
        consecutiveErrors: newErrors,
        nextFetchAfter: nextFetch,
      })
      .where(eq(sources.id, source.id))
      .catch(() => {});

    return {
      releasesFound: 0,
      releasesInserted: 0,
      durationMs: Date.now() - start,
      status: "error" as const,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Source of truth: src/adapters/github.ts#fetchChangelogFiles. Worker uses
// Web Crypto + Hono db binding, so the implementation is duplicated rather
// than imported to keep the worker bundle free of Node/Bun globals.

const CHANGELOG_FILENAMES = [
  "CHANGELOG.md",
  "CHANGELOG.rst",
  "CHANGELOG.txt",
  "CHANGELOG",
  "CHANGES.md",
  "CHANGES.rst",
  "HISTORY.md",
  "RELEASES.md",
  "NEWS.md",
];

const CHANGELOG_MAX_BYTES = 1024 * 1024;
const CHANGELOG_MAX_FILES = 20;

interface GitHubContentEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

async function sha256HexWorker(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function truncateToByteCap(content: string): {
  content: string;
  bytes: number;
  truncated: boolean;
} {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content).length;
  if (bytes <= CHANGELOG_MAX_BYTES) return { content, bytes, truncated: false };
  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (encoder.encode(content.slice(0, mid)).length <= CHANGELOG_MAX_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const sliced = content.slice(0, lo);
  return { content: sliced, bytes: encoder.encode(sliced).length, truncated: true };
}

function parseWorkspaces(pkgJsonText: string): string[] {
  try {
    const parsed = JSON.parse(pkgJsonText) as { workspaces?: unknown };
    const ws = parsed.workspaces;
    if (!ws) return [];
    if (Array.isArray(ws)) return ws.filter((x): x is string => typeof x === "string");
    if (
      typeof ws === "object" &&
      ws !== null &&
      Array.isArray((ws as { packages?: unknown }).packages)
    ) {
      return (ws as { packages: unknown[] }).packages.filter(
        (x): x is string => typeof x === "string",
      );
    }
    return [];
  } catch {
    return [];
  }
}

async function listDirContents(
  owner: string,
  repo: string,
  dir: string,
  apiHeaders: Record<string, string>,
): Promise<GitHubContentEntry[] | null> {
  try {
    const url = dir
      ? `https://api.github.com/repos/${owner}/${repo}/contents/${dir}`
      : `https://api.github.com/repos/${owner}/${repo}/contents/`;
    const res = await fetch(url, { headers: apiHeaders });
    if (!res.ok) return null;
    return (await res.json()) as GitHubContentEntry[];
  } catch {
    return null;
  }
}

function pickChangelog(entries: GitHubContentEntry[]): string | null {
  const files = new Set(entries.filter((e) => e.type === "file").map((e) => e.name));
  return CHANGELOG_FILENAMES.find((name) => files.has(name)) ?? null;
}

interface WorkerFetchedFile {
  path: string;
  filename: string;
  url: string;
  rawUrl: string;
  content: string;
  contentHashHex: string;
  bytes: number;
  truncated: boolean;
}

async function fetchOneFile(
  owner: string,
  repo: string,
  dir: string,
  filename: string,
  rawHeaders: Record<string, string>,
  sourceSlug: string,
): Promise<WorkerFetchedFile | null> {
  const fullPath = dir ? `${dir}/${filename}` : filename;
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${fullPath}`;
  let res: Response;
  try {
    res = await fetch(rawUrl, { headers: rawHeaders });
  } catch (err) {
    console.warn(
      `[cron] refreshChangelogFile(${sourceSlug}): raw fetch failed for ${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (!res.ok) {
    console.warn(
      `[cron] refreshChangelogFile(${sourceSlug}): raw fetch ${res.status} for ${fullPath}`,
    );
    return null;
  }
  const raw = await res.text();
  const { content, bytes, truncated } = truncateToByteCap(raw);
  if (truncated) {
    console.warn(
      `[cron] refreshChangelogFile(${sourceSlug}): ${fullPath} exceeds size cap, truncated to ${bytes} bytes`,
    );
  }
  const contentHashHex = await sha256HexWorker(content);
  return {
    path: fullPath,
    filename,
    url: `https://github.com/${owner}/${repo}/blob/HEAD/${fullPath}`,
    rawUrl,
    content,
    contentHashHex,
    bytes,
    truncated,
  };
}

/**
 * Discover and refresh all tracked CHANGELOG files for a GitHub source —
 * root plus per-package files resolved from `package.json#workspaces`.
 * Capped at CHANGELOG_MAX_FILES. Emits one info log summarizing file/request
 * counts. Callers (cron) wrap this in a try/catch so the outer fetch never
 * fails on a changelog refresh error.
 */
/**
 * Refresh the GitHub CHANGELOG mirror for a source.
 *
 * Historical default: upsert files AND embed changed ones inline (fire-and-
 * forget). When `opts.skipEmbed` is true, returns the changed file list so
 * the caller can embed in a separate step (used by the Workflows path in
 * #486 so the embed retry is independent of the file refresh retry).
 */
export async function refreshChangelogFile(
  db: ReturnType<typeof drizzle>,
  source: Source,
  token: string | undefined,
  env: FetchOneEnv,
  opts?: { skipEmbed?: boolean },
): Promise<{ changedFiles: ChangedChangelogFile[] }> {
  const skipEmbed = opts?.skipEmbed ?? false;
  const match = source.url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return { changedFiles: [] };
  const [, owner, rawRepo] = match;
  const repo = rawRepo.replace(/\.git$/, "");

  const apiHeaders: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": RELEASES_BOT_UA,
  };
  if (token) apiHeaders.Authorization = `Bearer ${token}`;
  const rawHeaders: Record<string, string> = { "User-Agent": RELEASES_BOT_UA };
  if (token) rawHeaders.Authorization = `Bearer ${token}`;

  let requestCount = 0;
  const fetched: WorkerFetchedFile[] = [];

  // Override path via source.metadata.changelogPaths.
  let override: string[] | null = null;
  if (source.metadata) {
    try {
      const meta = JSON.parse(source.metadata) as { changelogPaths?: unknown };
      if (Array.isArray(meta.changelogPaths)) {
        override = (meta.changelogPaths as unknown[]).filter(
          (x): x is string => typeof x === "string",
        );
      }
    } catch {
      override = null;
    }
  }

  const rootListing = await listDirContents(owner, repo, "", apiHeaders);
  requestCount++;
  if (!rootListing) {
    console.log(`[cron] refreshChangelogFile(${source.slug}): 0 files, ${requestCount} requests`);
    return { changedFiles: [] };
  }
  const rootFilename = pickChangelog(rootListing);
  if (rootFilename) {
    const f = await fetchOneFile(owner, repo, "", rootFilename, rawHeaders, source.slug);
    requestCount++;
    if (f) fetched.push(f);
  }

  if (override && override.length > 0) {
    const seen = new Set(fetched.map((f) => f.path));
    for (const entry of override) {
      if (fetched.length >= CHANGELOG_MAX_FILES) break;
      const normalized = entry.replace(/^\.?\//, "");
      if (seen.has(normalized)) continue;
      const lastSlash = normalized.lastIndexOf("/");
      const dir = lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
      const filename = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
      // oxlint-disable-next-line no-await-in-loop -- rate-limited GitHub raw content API
      const f = await fetchOneFile(owner, repo, dir, filename, rawHeaders, source.slug);
      requestCount++;
      if (f) {
        fetched.push(f);
        seen.add(f.path);
      }
    }
  } else {
    const hasPkg = rootListing.some((e) => e.type === "file" && e.name === "package.json");
    if (hasPkg) {
      let pkgText: string | null = null;
      try {
        const pr = await fetch(
          `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/package.json`,
          { headers: rawHeaders },
        );
        requestCount++;
        if (pr.ok) pkgText = await pr.text();
      } catch {
        pkgText = null;
      }
      const globs = pkgText ? parseWorkspaces(pkgText) : [];
      const packageDirs: string[] = [];
      for (const glob of globs) {
        if (packageDirs.length + fetched.length >= CHANGELOG_MAX_FILES) break;
        const trimmed = glob.replace(/\/$/, "");
        if (trimmed.startsWith("!") || trimmed.includes("**")) continue;
        if (trimmed.endsWith("/*")) {
          const parent = trimmed.slice(0, -2);
          if (!parent || parent.includes("*")) continue;
          // oxlint-disable-next-line no-await-in-loop -- rate-limited GitHub API; each glob dir fetched sequentially
          const parentEntries = await listDirContents(owner, repo, parent, apiHeaders);
          requestCount++;
          if (!parentEntries) continue;
          for (const entry of parentEntries) {
            if (entry.type !== "dir") continue;
            packageDirs.push(`${parent}/${entry.name}`);
            if (packageDirs.length + fetched.length >= CHANGELOG_MAX_FILES) break;
          }
        } else if (!trimmed.includes("*")) {
          packageDirs.push(trimmed);
        }
      }
      for (const dir of packageDirs) {
        if (fetched.length >= CHANGELOG_MAX_FILES) break;
        // oxlint-disable-next-line no-await-in-loop -- rate-limited GitHub API; each package dir fetched sequentially
        const entries = await listDirContents(owner, repo, dir, apiHeaders);
        requestCount++;
        if (!entries) continue;
        const filename = pickChangelog(entries);
        if (!filename) continue;
        // oxlint-disable-next-line no-await-in-loop -- rate-limited GitHub raw content API
        const f = await fetchOneFile(owner, repo, dir, filename, rawHeaders, source.slug);
        requestCount++;
        if (f) fetched.push(f);
      }
    }
  }

  console.log(
    `[cron] refreshChangelogFile(${source.slug}): ${fetched.length} files, ${requestCount} requests`,
  );

  const now = new Date().toISOString();

  // Upsert each fetched file.
  const existing = await db
    .select()
    .from(sourceChangelogFiles)
    .where(eq(sourceChangelogFiles.sourceId, source.id));
  const existingByPath = new Map(existing.map((e) => [e.path, e]));

  // Track files whose content changed so we can embed them after DB writes.
  const changed: Array<{ fileId: string; content: string; contentHash: string }> = [];
  for (const file of fetched) {
    const prior = existingByPath.get(file.path);
    if (!prior) {
      // oxlint-disable-next-line no-await-in-loop -- sequential upsert: each file insert must complete before checking the next
      const [row] = await db
        .insert(sourceChangelogFiles)
        .values({
          sourceId: source.id,
          path: file.path,
          filename: file.filename,
          url: file.url,
          rawUrl: file.rawUrl,
          content: file.content,
          contentHash: file.contentHashHex,
          bytes: file.bytes,
          tokens: countTokensSafe(file.content),
          fetchedAt: now,
        })
        .returning({ id: sourceChangelogFiles.id });
      if (row)
        changed.push({ fileId: row.id, content: file.content, contentHash: file.contentHashHex });
      console.log(
        `[cron] Inserted ${file.path} for ${source.slug} (${file.bytes} bytes${file.truncated ? ", truncated" : ""})`,
      );
    } else if (prior.contentHash === file.contentHashHex) {
      // Hash unchanged — short-circuit, no embed needed. Backfill tokens if the prior row predates that column.
      const touch: { fetchedAt: string; tokens?: number } = { fetchedAt: now };
      if (prior.tokens === null) touch.tokens = countTokensSafe(prior.content);
      // oxlint-disable-next-line no-await-in-loop -- sequential per-file touch (content unchanged path)
      await db.update(sourceChangelogFiles).set(touch).where(eq(sourceChangelogFiles.id, prior.id));
    } else {
      // oxlint-disable-next-line no-await-in-loop -- sequential per-file update (content changed path)
      await db
        .update(sourceChangelogFiles)
        .set({
          filename: file.filename,
          url: file.url,
          rawUrl: file.rawUrl,
          content: file.content,
          contentHash: file.contentHashHex,
          bytes: file.bytes,
          tokens: countTokensSafe(file.content),
          fetchedAt: now,
        })
        .where(eq(sourceChangelogFiles.id, prior.id));
      changed.push({ fileId: prior.id, content: file.content, contentHash: file.contentHashHex });
      console.log(
        `[cron] Updated ${file.path} for ${source.slug} (${file.bytes} bytes${file.truncated ? ", truncated" : ""})`,
      );
    }
  }

  // Embed changed changelog files into CHANGELOG_CHUNKS_INDEX. Historical
  // inline path runs best-effort (logged-and-swallowed) so failures don't
  // stop the outer fetch. When `skipEmbed` is true the caller (e.g. the
  // Workflows path) handles embed in a separate retriable step. Skipped
  // either way when the Vectorize binding is missing.
  if (!skipEmbed && changed.length > 0 && env.CHANGELOG_CHUNKS_INDEX) {
    for (const file of changed) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential per-file embed to avoid flooding the embedding provider
        await embedChangelogFileForSource(db, source, file, env);
      } catch (err) {
        console.warn(
          `[cron] changelog embed failed for ${source.slug} (${file.fileId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Prune any rows that are no longer in the discovered set.
  const keep = new Set(fetched.map((f) => f.path));
  const toDelete = existing.filter((row) => !keep.has(row.path));
  for (const row of toDelete) {
    // oxlint-disable-next-line no-await-in-loop -- sequential prune; set is typically empty or 1-2 rows
    await db.delete(sourceChangelogFiles).where(eq(sourceChangelogFiles.id, row.id));
    console.log(`[cron] Pruned ${row.path} for ${source.slug}`);
  }

  return { changedFiles: changed };
}

/** Payload a caller needs to re-embed a changelog file after upsert. */
export interface ChangedChangelogFile {
  fileId: string;
  content: string;
  contentHash: string;
}

// ── GitHub fetch (Worker-side) ──

async function fetchGitHub(source: Source, token?: string): Promise<RawRelease[]> {
  const match = source.url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return [];
  const [, owner, rawRepo] = match;
  const repo = rawRepo.replace(/\.git$/, "");

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": RELEASES_BOT_UA,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`, {
    headers,
  });

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} for ${owner}/${repo}`);
  }

  const data: Array<{
    tag_name: string;
    name: string | null;
    body: string | null;
    html_url: string;
    published_at: string | null;
  }> = await res.json();

  return data.slice(0, 200).map((rel) => ({
    version: rel.tag_name,
    title: rel.name || rel.tag_name,
    content: rel.body || "",
    url: rel.html_url,
    publishedAt: rel.published_at ? new Date(rel.published_at) : undefined,
  }));
}

// ── Embedding side effects ──
//
// These helpers hydrate DB rows, build the embed config from Worker secrets,
// push vectors to Vectorize, and mark the rows as embedded. All failures are
// swallowed by the shared helpers in @releases/search/embed-* so the callers never
// need to try/catch.

export async function embedReleasesForSource(
  db: ReturnType<typeof drizzle>,
  source: Source,
  releaseIds: string[],
  env: FetchOneEnv,
  opts?: { throwOnError?: boolean },
): Promise<void> {
  const embedConfig = await buildEmbedConfig(env);
  if (!embedConfig || !env.RELEASES_INDEX) return;

  // D1 caps prepared statements at 100 bound parameters; chunk the IN list.
  const selectRow = (slice: string[]) =>
    db
      .select({
        id: releases.id,
        title: releases.title,
        content: releases.content,
        contentSummary: releases.contentSummary,
        version: releases.version,
        publishedAt: releases.publishedAt,
        sourceId: releases.sourceId,
        type: releases.type,
      })
      .from(releases)
      .where(inArray(releases.id, slice));
  type EmbedRow = Awaited<ReturnType<typeof selectRow>>[number];
  const rowsToEmbed: EmbedRow[] = [];
  for (let i = 0; i < releaseIds.length; i += RELEASES_ID_IN_CHUNK_SIZE) {
    // oxlint-disable-next-line no-await-in-loop -- D1 chunked select (100 bind param limit)
    const part = await selectRow(releaseIds.slice(i, i + RELEASES_ID_IN_CHUNK_SIZE));
    rowsToEmbed.push(...part);
  }

  // Load org category for metadata filtering.
  let category: string | null = null;
  if (source.orgId) {
    const orgRow = await db.run(
      sql`SELECT category FROM organizations WHERE id = ${source.orgId} LIMIT 1`,
    );
    const first = (orgRow.results as Array<{ category: string | null }> | undefined)?.[0];
    category = first?.category ?? null;
  }

  await embedAndUpsertReleases({
    // oxlint-disable-next-line no-map-spread -- copy-on-write required; r is a DB row
    releases: rowsToEmbed.map((r) => ({
      ...r,
      orgId: source.orgId,
      productId: source.productId,
      category,
    })),
    // See FetchOneEnv note: shared interface differs from workers-types only
    // in metadata variance. Cast is safe at runtime.
    vectorIndex: env.RELEASES_INDEX as VectorizeIndex,
    embedConfig,
    throwOnError: opts?.throwOnError ?? false,
    onPersisted: async (ids) => {
      if (ids.length === 0) return;
      const now = new Date().toISOString();
      // UPDATE adds a SET binding, so 100 IDs would push the statement to 101
      // params and 500 against D1. RELEASES_ID_IN_CHUNK_SIZE (90) leaves room.
      for (let i = 0; i < ids.length; i += RELEASES_ID_IN_CHUNK_SIZE) {
        const slice = ids.slice(i, i + RELEASES_ID_IN_CHUNK_SIZE);
        // oxlint-disable-next-line no-await-in-loop -- D1 chunked update (100 bind param limit)
        await db.update(releases).set({ embeddedAt: now }).where(inArray(releases.id, slice));
      }
    },
  });
}

export async function embedChangelogFileForSource(
  db: ReturnType<typeof drizzle>,
  source: Source,
  file: { fileId: string; content: string; contentHash: string },
  env: FetchOneEnv,
  opts?: { throwOnError?: boolean },
): Promise<void> {
  const embedConfig = await buildEmbedConfig(env);
  if (!embedConfig || !env.CHANGELOG_CHUNKS_INDEX) return;

  // Load existing chunks for this file so the diff can detect unchanged
  // sections and avoid re-embedding them.
  const existingRows = await db
    .select({
      id: sourceChangelogChunks.id,
      offset: sourceChangelogChunks.offset,
      contentHash: sourceChangelogChunks.contentHash,
      vectorId: sourceChangelogChunks.vectorId,
    })
    .from(sourceChangelogChunks)
    .where(eq(sourceChangelogChunks.sourceChangelogFileId, file.fileId));

  await embedAndUpsertChangelogFile({
    file: {
      id: file.fileId,
      sourceId: source.id,
      content: file.content,
      contentHash: file.contentHash,
    },
    existingChunks: existingRows.map((r) => ({
      id: r.id,
      offset: r.offset,
      contentHash: r.contentHash,
      vectorId: r.vectorId,
    })),
    vectorIndex: env.CHANGELOG_CHUNKS_INDEX as VectorizeIndex,
    embedConfig,
    throwOnError: opts?.throwOnError ?? false,
    onDiff: async ({ diff, embedded }) => {
      const now = new Date().toISOString();

      // 1. Delete stale rows.
      if (diff.toDelete.length > 0) {
        const ids = diff.toDelete.map((d) => d.id);
        for (let i = 0; i < ids.length; i += 100) {
          const slice = ids.slice(i, i + 100);
          // oxlint-disable-next-line no-await-in-loop -- D1 chunked delete (100 bind param limit)
          await db.delete(sourceChangelogChunks).where(inArray(sourceChangelogChunks.id, slice));
        }
      }

      // 2. Update unchanged rows to reflect the new offset/heading/length.
      //    One-at-a-time is fine — the diff is usually small.
      for (const u of diff.unchanged) {
        // oxlint-disable-next-line no-await-in-loop -- sequential per-chunk offset update (diff is typically small)
        await db
          .update(sourceChangelogChunks)
          .set({
            offset: u.chunk.offset,
            length: u.chunk.length,
            tokens: u.chunk.tokens,
            heading: u.chunk.heading,
          })
          .where(eq(sourceChangelogChunks.id, u.id));
      }

      // 3. Insert new rows. Rows whose embed succeeded get vectorId +
      //    embeddedAt; the rest land with vectorId = NULL so the backfill
      //    job can embed them later.
      const embeddedByHash = new Map(embedded.map((e) => [e.chunk.contentHash, e]));
      if (diff.toInsert.length > 0) {
        const values = diff.toInsert.map((chunk) => {
          const match = embeddedByHash.get(chunk.contentHash);
          return {
            sourceChangelogFileId: file.fileId,
            sourceId: source.id,
            offset: chunk.offset,
            length: chunk.length,
            tokens: chunk.tokens,
            contentHash: chunk.contentHash,
            heading: chunk.heading,
            vectorId: match?.vectorId ?? null,
            embeddedAt: match ? now : null,
          };
        });
        // D1 caps bound parameters per statement at ~100. This table has
        // 11 columns, so 9 rows per batch keeps us under the limit.
        for (let i = 0; i < values.length; i += 9) {
          // oxlint-disable-next-line no-await-in-loop -- D1 chunked insert (100 bind param limit; 11 cols → 9 rows/batch)
          await db.insert(sourceChangelogChunks).values(values.slice(i, i + 9));
        }
      }
    },
  });
}
