import { eq, and, or, sql, isNull, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  sources,
  sourcesVisible,
  releases,
  fetchLog,
  sourceChangelogFiles,
  sourceChangelogChunks,
  knowledgePages,
} from "@buildinternet/releases-core/schema";
import { countTokensSafe, computeContentSize } from "@buildinternet/releases-core/tokens";
import type { Source } from "@buildinternet/releases-core/schema";
import {
  headCheckUrl,
  bodyHashCheck,
  fetchAndParseFeed,
  filterByCategoryAllow,
  getSourceMeta,
  isGitHubFetched,
  effectiveGitHubUrl,
  synthesizeReleaseUrl,
  FEED_4XX_INVALIDATE_THRESHOLD,
  CLEARED_FEED_FIELDS,
} from "@releases/adapters/feed.js";
import type { SourceMetadata, ChangeStatus } from "@releases/adapters/feed.js";
import { loadFetchQuirks, type FetchQuirk } from "@releases/ai-internal/playbook";
import { FeedHttpError } from "@releases/lib/errors";
import { contentHash } from "@releases/adapters/content-hash";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import type { RawRelease } from "@releases/adapters/types.js";
import {
  discoverChangelogPaths,
  buildGitHubHeaders,
  parseOwnerRepo,
} from "@releases/adapters/github-discovery";
import { CHANGELOG_MAX_FILES, truncateToByteCap } from "@releases/adapters/github";
import { isPrereleaseVersion } from "@buildinternet/releases-core/prerelease";
import { computeVersionSort } from "@buildinternet/releases-core/version-sort";
import { normalizeMediaUrl } from "@releases/rendering/media-url.js";
import {
  embedAndUpsertChangelogFile,
  type EmbeddedChunk,
} from "@releases/search/embed-changelog-pipeline.js";
import type { DiffResult } from "@releases/search/embed-changelogs.js";
import { buildEmbedConfig } from "../lib/embed-config.js";
import { runWithConcurrency } from "../lib/concurrency.js";
import type { VectorizeIndex } from "@releases/search/vector-search.js";
import { embedAndUpsertReleases } from "@releases/search/embed-releases.js";
import {
  RELEASES_BATCH_CHUNK_SIZE,
  RELEASES_ID_IN_CHUNK_SIZE,
  CHANGELOG_CHUNK_INSERT_CHUNK_SIZE,
} from "../lib/d1-limits.js";
import { publishReleaseEvents } from "../events/publish.js";
import { invalidateLatestCache } from "../lib/latest-cache.js";
import type { InvalidationEnv } from "../lib/latest-cache.js";
import type { InsertedReleaseRow } from "../events/build-event.js";
import { notifyIndexNowForSource, type IndexNowEnv } from "../lib/indexnow.js";
import { clusterAndPersistCascades } from "../lib/cluster-cascades.js";
import { resolveOrgSlug, resolveProductSlug } from "../lib/slug-lookups.js";
import { logEvent } from "@releases/lib/log-event";
import { classifyDbError, dbErrorLogFields } from "@releases/lib/db-errors";

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
    logEvent("info", { component: "cron-poll-fetch", event: "cron-disabled" });
    return;
  }

  const db = drizzle(env.DB);
  const now = new Date();
  const changeDetectEnabled = env.SCRAPE_CHANGE_DETECT_ENABLED === "true";

  // Query sources due for a poll
  const dueSources = await queryDueSources(db, now, { changeDetectEnabled });
  if (dueSources.length === 0) return;

  logEvent("info", {
    component: "cron-poll-fetch",
    event: "polling",
    sourceCount: dueSources.length,
  });

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
    logEvent("info", {
      component: "cron-poll-fetch",
      event: "fetching-changed",
      sourceCount: fetchable.length,
    });
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
    logEvent("info", {
      component: "cron-poll-fetch",
      event: "scrape-agent-flagged",
      sourceCount: changedScrape.length,
    });
  }
}

// ── Query due sources ──

export async function queryDueSources(
  db: ReturnType<typeof drizzle>,
  now: Date,
  opts?: { changeDetectEnabled?: boolean },
): Promise<Source[]> {
  const notPaused = sql`${sourcesVisible.fetchPriority} != 'paused'`;
  // Include sources that have a feed URL OR are GitHub type (GitHub sources
  // don't store a feedUrl — they use the GitHub releases API directly), OR
  // carry a `metadata.githubUrl` fetch override (#831 — scrape sources opting
  // into the GitHub releases API while keeping a human-readable canonical URL).
  // Behind SCRAPE_CHANGE_DETECT_ENABLED (#517), also include scrape/agent
  // sources with no feedUrl — `pollOne` routes those to a detector from the
  // playbook's `fetchQuirks` (unreliable class is a no-op, so the widened
  // filter doesn't explode poll volume).
  const pollable = opts?.changeDetectEnabled
    ? sql`(json_extract(${sourcesVisible.metadata}, '$.feedUrl') IS NOT NULL OR json_extract(${sourcesVisible.metadata}, '$.githubUrl') IS NOT NULL OR ${sourcesVisible.type} = 'github' OR ${sourcesVisible.type} IN ('scrape','agent'))`
    : sql`(json_extract(${sourcesVisible.metadata}, '$.feedUrl') IS NOT NULL OR json_extract(${sourcesVisible.metadata}, '$.githubUrl') IS NOT NULL OR ${sourcesVisible.type} = 'github')`;

  // Build OR conditions for each tier using sql template to avoid enum type issues
  const tierConditions = (Object.keys(TIER_INTERVALS) as PollTier[]).map((tier) => {
    const hours = TIER_INTERVALS[tier];
    const cutoff = new Date(now.getTime() - hours * 3600_000).toISOString();
    return and(
      sql`${sourcesVisible.fetchPriority} = ${tier}`,
      or(isNull(sourcesVisible.lastPolledAt), sql`${sourcesVisible.lastPolledAt} < ${cutoff}`),
    );
  });

  return db
    .select()
    .from(sourcesVisible)
    .where(and(pollable, notPaused, or(...tierConditions)));
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

  // GitHub sources (canonical or via metadata.githubUrl override) don't have
  // feeds to HEAD-check — mark as changed so the fetch phase always runs
  // (dedup happens at the DB insert level).
  if (isGitHubFetched(source, meta)) {
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
    logEvent("info", {
      component: "cron-poll-fetch",
      event: "poll-result",
      sourceSlug: source.slug,
      status: result.status,
      responseMs: result.responseMs,
    });

    return { source, changed };
  } catch (err) {
    // Don't let one source failure stop the whole cron
    logEvent("error", {
      component: "cron-poll-fetch",
      event: "poll-error",
      sourceSlug: source.slug,
      err: err instanceof Error ? err : String(err),
    });
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
 *   body-hash-filtered    → GET + SHA-256 after stripping volatile markup
 *                           (script/style/link/meta/comments). For SSR
 *                           pages whose body churns per-request (#789).
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
    logEvent("info", {
      component: "cron-poll-fetch",
      event: "poll-quirk-outcome",
      sourceSlug: source.slug,
      detector,
      outcome,
      durationMs,
      ...(extra ? { extra } : {}),
    });
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
      case "body-hash":
      case "body-hash-filtered": {
        const result = await bodyHashCheck(probeUrl, meta.pageContentHash, {
          filter: detector === "body-hash-filtered",
        });
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
    logOutcome(detector, status === "changed" || status === "unknown" ? "changed" : "unchanged");
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

export interface FetchOneEnv extends IndexNowEnv {
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
  /**
   * Service binding to the discovery worker. When present, summary-only feeds
   * (items with only titles + links — no body) with `crawlEnabled: true` are
   * delegated to discovery's `POST /sources/:id/fetch` endpoint so per-release
   * pages can be crawled and extracted for content + media. See {@link shouldDelegateToCrawl}.
   */
  DISCOVERY_WORKER?: Fetcher;
}

/**
 * True when this source should hand body-fetching off to the discovery
 * worker's crawl pipeline instead of inserting the feed-parsed rows directly.
 *
 * The signal is "the feed gave us titles but no bodies." That's either an
 * explicit `feedContentDepth: "summary-only"` tag on the source metadata, or
 * the empirical reality that every parsed item came back with empty content.
 * Either way, inserting those stubs would persist empty `content` + empty
 * `media` rows under whatever URLs the feed handed us — exactly the bug that
 * left Notion's recent releases empty after the upstream feed switched to a
 * title-only format and we kept ingesting it as-is.
 *
 * Gated on `crawlEnabled` because the alternative is "do nothing useful" —
 * if the operator hasn't opted into crawl-based enrichment we don't have a
 * second path to try, and inserting the stubs is still better than dropping
 * the change signal entirely.
 *
 * Pure and side-effect-free so we can unit-test the decision matrix without
 * spinning up a worker env.
 */
export function shouldDelegateToCrawl(
  source: Source,
  meta: SourceMetadata,
  rawReleases: readonly RawRelease[],
): boolean {
  if (source.type !== "scrape") return false;
  if (meta.crawlEnabled !== true) return false;
  if (rawReleases.length === 0) return false;
  if (meta.feedContentDepth === "summary-only") return true;
  // Treat an all-empty-content batch the same as an explicit summary-only
  // tag: the feed didn't actually deliver bodies, regardless of what it
  // self-described as. Whitespace-only counts as empty.
  return rawReleases.every((r) => !r.content || r.content.trim() === "");
}

/**
 * Hand the source off to the discovery worker's `POST /sources/:id/fetch`
 * endpoint and map its response onto {@link FetchOneResult}. Discovery owns
 * its own `fetch_log` + source-counter bookkeeping for both success and error
 * paths, so this helper does not write to either — bumping `consecutiveErrors`
 * twice (once here, once in discovery's `updateSourceAfterFetch`) would
 * over-penalize the source. Network failures, on the other hand, mean
 * discovery never ran at all, so we throw and let the caller's catch block
 * record the error like any other transport failure.
 */
async function delegateScrapeToDiscovery(
  source: Source,
  discoveryWorker: Fetcher,
  sessionId: string | null,
): Promise<FetchOneResult> {
  const start = Date.now();
  const res = await discoveryWorker.fetch(
    `https://discovery/sources/${encodeURIComponent(source.id)}/fetch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId ?? undefined }),
    },
  );

  const durationMs = Date.now() - start;
  let body: { ok?: boolean; result?: string; errorCategory?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Non-JSON response — fall through and use the status code below.
  }

  if (!res.ok || body.ok === false) {
    const errorMessage = body.result ?? `Discovery /sources/:id/fetch returned HTTP ${res.status}`;
    logEvent("warn", {
      component: "cron-poll-fetch",
      event: "crawl-delegation-failed",
      sourceSlug: source.slug,
      httpStatus: res.status,
      errorCategory: body.errorCategory,
      durationMs,
    });
    return {
      releasesFound: 0,
      releasesInserted: 0,
      durationMs,
      status: "error" as const,
      error: errorMessage,
    };
  }

  // `result` is a JSON-stringified `{fetched, status, releasesFound, releasesInserted, source}`.
  // Fall back to zeros if it's missing or unparseable rather than failing the whole pass.
  let releasesFound = 0;
  let releasesInserted = 0;
  try {
    const parsed = JSON.parse(body.result ?? "{}") as {
      releasesFound?: number;
      releasesInserted?: number;
    };
    releasesFound = parsed.releasesFound ?? 0;
    releasesInserted = parsed.releasesInserted ?? 0;
  } catch {
    /* keep zeros */
  }

  logEvent("info", {
    component: "cron-poll-fetch",
    event: "crawl-delegation-success",
    sourceSlug: source.slug,
    releasesFound,
    releasesInserted,
    durationMs,
  });

  return {
    releasesFound,
    releasesInserted,
    durationMs,
    status: releasesInserted > 0 ? ("success" as const) : ("no_change" as const),
  };
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

    if (isGitHubFetched(source, meta)) {
      rawReleases = await fetchGitHub(source, env.GITHUB_TOKEN, {
        repoUrl: effectiveGitHubUrl(source, meta),
      });
    } else {
      if (!meta.feedUrl || !meta.feedType) {
        logEvent("warn", {
          component: "cron-poll-fetch",
          event: "fetch-missing-feed",
          sourceSlug: source.slug,
        });
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

      if (meta.categoryAllow && meta.categoryAllow.length > 0) {
        const filtered = filterByCategoryAllow(rawReleases, meta.categoryAllow);
        if (filtered.dropped > 0) {
          logEvent("info", {
            component: "cron-poll-fetch",
            event: "category-filter-applied",
            sourceSlug: source.slug,
            kept: filtered.kept.length,
            dropped: filtered.dropped,
            categoryAllow: meta.categoryAllow,
          });
        }
        rawReleases = filtered.kept;
      }

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
      logEvent("info", {
        component: "cron-poll-fetch",
        event: "fetch-dry-run",
        sourceSlug: source.slug,
        releasesFound: rawReleases.length,
        durationMs: dur,
      });
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
      logEvent("info", {
        component: "cron-poll-fetch",
        event: "fetch-no-changes",
        sourceSlug: source.slug,
        durationMs: dur,
      });
      return {
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: dur,
        status: "no_change" as const,
      };
    }

    // Summary-only feed (e.g. RSS that only carries `<title>` + `<link>`):
    // inserting the parsed rows would persist empty-body releases under the
    // feed's link URLs. When `crawlEnabled: true` is set, delegate to the
    // discovery worker's crawl + extract pipeline instead so the per-release
    // pages get fetched and bodies + media land in D1. The feed becomes a
    // pure change detector. Dry-runs skip this branch — they're supposed to
    // be cheap probes of the feed itself, not full crawls.
    if (!dryRun && env.DISCOVERY_WORKER && shouldDelegateToCrawl(source, meta, rawReleases)) {
      logEvent("info", {
        component: "cron-poll-fetch",
        event: "crawl-delegation-start",
        sourceSlug: source.slug,
        reason:
          meta.feedContentDepth === "summary-only" ? "summary-only" : "all-items-empty-content",
        feedItemCount: rawReleases.length,
      });
      return await delegateScrapeToDiscovery(source, env.DISCOVERY_WORKER, sessionId);
    }

    const rows = rawReleases.map((raw) => {
      const size = computeContentSize(raw.content);
      return {
        sourceId: source.id,
        version: raw.version ?? null,
        versionSort: computeVersionSort(raw.version),
        title: raw.title,
        content: raw.content,
        url: raw.url ?? null,
        contentHash: contentHash(raw),
        contentChars: size.contentChars,
        contentTokens: size.contentTokens,
        publishedAt: raw.publishedAt?.toISOString() ?? null,
        prerelease: raw.prerelease ?? isPrereleaseVersion(raw.version),
        // Unwrap Next.js/Vercel image optimizer URLs so downstream R2 upload
        // and direct rendering both see the underlying CDN asset.
        media: JSON.stringify(
          // oxlint-disable-next-line no-map-spread -- copy-on-write required; m is an adapter-returned object
          (raw.media ?? []).map((m) => ({ ...m, url: normalizeMediaUrl(m.url) })),
        ),
      };
    });

    let inserted = 0;
    const publishRows: InsertedReleaseRow[] = [];
    const clusterRows: Array<{ id: string; version: string | null; content: string }> = [];
    for (let i = 0; i < rows.length; i += RELEASES_BATCH_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + RELEASES_BATCH_CHUNK_SIZE);
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
        content: releases.content,
        contentChars: releases.contentChars,
        contentTokens: releases.contentTokens,
      });
      inserted += result.length;
      for (const r of result) {
        const { content, ...publishRow } = r;
        publishRows.push(publishRow);
        clusterRows.push({ id: r.id, version: r.version, content });
      }
    }
    const insertedIds = publishRows.map((r) => r.id);

    // Detect changesets cascade rows and demote them to coverage so they
    // stay out of the default feed, the live tail, and per-source IndexNow
    // counts. Synchronous: coverage state must be visible to the publish
    // path below.
    const cascadeResult = await clusterAndPersistCascades(db, clusterRows, {
      component: "poll-fetch",
      sourceId: source.id,
    });
    const visiblePublishRows =
      cascadeResult.coverageIds.size > 0
        ? publishRows.filter((r) => !cascadeResult.coverageIds.has(r.id))
        : publishRows;

    if (visiblePublishRows.length > 0 && env.RELEASE_HUB) {
      await publishReleaseEvents(
        {
          RELEASE_HUB: env.RELEASE_HUB,
          WEBHOOK_DELIVERY_QUEUE: env.WEBHOOK_DELIVERY_QUEUE,
          DB: env.DB,
        },
        {
          src: { name: source.name, slug: source.slug, orgId: source.orgId, sourceId: source.id },
          inserted: visiblePublishRows,
        },
      );
    }

    // Fire-and-forget IndexNow ping for the org/source/product surfaces whose
    // lastmod just shifted. Skips itself when INDEXNOW_ENABLED is unset, so
    // staging and dev are no-ops by default. Per-release URLs are intentionally
    // out of scope — see https://github.com/buildinternet/releases/issues/649.
    if (visiblePublishRows.length > 0) {
      await notifyIndexNowForSource(
        env,
        {
          resolveOrgSlug: (id) => resolveOrgSlug(db, id),
          resolveProductSlug: (id) => resolveProductSlug(db, id),
        },
        {
          slug: source.slug,
          orgId: source.orgId,
          productId: source.productId,
          isHidden: source.isHidden,
          discovery: source.discovery,
        },
        visiblePublishRows.length,
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
        logEvent("warn", {
          component: "cron-poll-fetch",
          event: "embed-failed",
          sourceSlug: source.slug,
          err: err instanceof Error ? err : String(err),
        });
      }
    }

    // Single D1 round-trip: insert fetch_log + update sources atomically.
    // Promise.all would issue two separate RPCs and leave either half committed
    // on a mid-flight failure. db.batch() is strictly better here — a wedged
    // sources.nextFetchAfter (from a failed update) or a silent observability
    // gap (from a failed insert) are both avoided.
    const successOps = [
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
    ];
    await db.batch(successOps as [(typeof successOps)[number], ...typeof successOps]);

    // Refresh canonical CHANGELOG file for GitHub sources (mirrors CLI fetch step
    // in src/cli/commands/fetch.ts). Never fail the outer fetch if this errors.
    // Workflows path skips this and drives refresh + embed from separate steps.
    if (!skipSideEffects && isGitHubFetched(source, meta)) {
      try {
        await refreshChangelogFile(db, source, env.GITHUB_TOKEN, env);
      } catch (err) {
        logEvent("warn", {
          component: "cron-poll-fetch",
          event: "changelog-refresh-failed",
          sourceSlug: source.slug,
          err: err instanceof Error ? err : String(err),
        });
      }
    }

    const dur = Date.now() - start;
    logEvent("info", {
      component: "cron-poll-fetch",
      event: "fetch-done",
      sourceSlug: source.slug,
      inserted,
      durationMs: dur,
    });
    return {
      releasesFound: rawReleases.length,
      releasesInserted: inserted,
      durationMs: dur,
      status: inserted > 0 ? ("success" as const) : ("no_change" as const),
      insertedIds,
    };
  } catch (err) {
    const classified = classifyDbError(err);
    logEvent("error", {
      component: "cron-poll-fetch",
      event: "fetch-error",
      sourceSlug: source.slug,
      err: err instanceof Error ? err : String(err),
      ...dbErrorLogFields(err),
    });

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

    // Transient D1 failure (overload / network drop / storage reset). Don't
    // bump consecutiveErrors — it's not a source-level problem, just an
    // infra blip, and the exponential backoff would push a healthy source
    // out by 1-72h for what's typically a one-tick issue. The fetch_log row
    // above still records the failure for observability.
    if (classified?.transient) {
      return {
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: Date.now() - start,
        status: "error" as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 4xx on the stored feedUrl: track it via feed4xxStreak rather than the
    // generic consecutiveErrors backoff. Backoff would push the next retry
    // out by hours and slow self-healing — we'd rather keep the normal cron
    // cadence until the streak hits the invalidation threshold.
    if (err instanceof FeedHttpError) {
      const streak = (meta.feed4xxStreak ?? 0) + 1;
      if (streak >= FEED_4XX_INVALIDATE_THRESHOLD) {
        logEvent("warn", {
          component: "cron-poll-fetch",
          event: "feed-url-invalidated",
          sourceSlug: source.slug,
          streak,
          httpStatus: err.status,
        });
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

async function sha256HexWorker(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    logEvent("warn", {
      component: "cron-poll-fetch",
      event: "changelog-raw-fetch-failed",
      sourceSlug,
      path: fullPath,
      err: err instanceof Error ? err : String(err),
    });
    return null;
  }
  if (!res.ok) {
    logEvent("warn", {
      component: "cron-poll-fetch",
      event: "changelog-raw-fetch-non-ok",
      sourceSlug,
      path: fullPath,
      httpStatus: res.status,
    });
    return null;
  }
  const raw = await res.text();
  const { content, bytes, truncated } = truncateToByteCap(raw);
  if (truncated) {
    logEvent("warn", {
      component: "cron-poll-fetch",
      event: "changelog-truncated",
      sourceSlug,
      path: fullPath,
      bytes,
    });
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
 * Refresh the GitHub CHANGELOG mirror for a source.
 *
 * Path planning is delegated to `discoverChangelogPaths` from
 * `@releases/adapters/github-discovery` (the same planner the probe endpoint
 * uses), so pnpm-workspace.yaml, package.json#workspaces, and
 * metadata.changelogPaths overrides are all handled identically. The worker
 * retains its own fetch + D1 upsert for the persistence half.
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
  // Resolve the effective fetch URL (metadata.githubUrl overrides source.url
  // for scrape sources opting into the GitHub fetch path — #831). Shadow the
  // source object so the discovery planner sees the override without mutation.
  const meta = getSourceMeta(source);
  const repoUrl = effectiveGitHubUrl(source, meta);
  if (!parseOwnerRepo(repoUrl)) return { changedFiles: [] };
  const fetchSource: Source = repoUrl === source.url ? source : { ...source, url: repoUrl };

  const headers = buildGitHubHeaders(token, RELEASES_BOT_UA);

  // Delegate path planning to the shared planner so pnpm-workspace.yaml,
  // package.json#workspaces, and metadata.changelogPaths overrides are all
  // handled identically to what the probe endpoint reports.
  const planned = await discoverChangelogPaths(fetchSource, headers);
  if (!planned) {
    logEvent("info", {
      component: "cron-poll-fetch",
      event: "changelog-no-root-listing",
      sourceSlug: source.slug,
    });
    return { changedFiles: [] };
  }

  const owner = parseOwnerRepo(repoUrl)!.owner;
  const repo = parseOwnerRepo(repoUrl)!.repo;

  const fetchable = planned.filter((p) => p.exists).slice(0, CHANGELOG_MAX_FILES);
  let requestCount = 0;
  const fetched: WorkerFetchedFile[] = [];
  for (const entry of fetchable) {
    const lastSlash = entry.path.lastIndexOf("/");
    const dir = lastSlash === -1 ? "" : entry.path.slice(0, lastSlash);
    const filename = lastSlash === -1 ? entry.path : entry.path.slice(lastSlash + 1);
    // oxlint-disable-next-line no-await-in-loop -- rate-limited GitHub raw content API; fetch sequentially
    const f = await fetchOneFile(owner, repo, dir, filename, headers.rawHeaders, source.slug);
    requestCount++;
    if (f) fetched.push(f);
  }

  logEvent("info", {
    component: "cron-poll-fetch",
    event: "changelog-refresh-done",
    sourceSlug: source.slug,
    fileCount: fetched.length,
    requestCount,
  });

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
      logEvent("info", {
        component: "cron-poll-fetch",
        event: "changelog-file-inserted",
        sourceSlug: source.slug,
        path: file.path,
        bytes: file.bytes,
        truncated: file.truncated,
      });
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
      logEvent("info", {
        component: "cron-poll-fetch",
        event: "changelog-file-updated",
        sourceSlug: source.slug,
        path: file.path,
        bytes: file.bytes,
        truncated: file.truncated,
      });
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
        logEvent("warn", {
          component: "cron-poll-fetch",
          event: "changelog-embed-failed",
          sourceSlug: source.slug,
          fileId: file.fileId,
          err: err instanceof Error ? err : String(err),
        });
      }
    }
  }

  // Prune any rows that are no longer in the discovered set.
  const keep = new Set(fetched.map((f) => f.path));
  const toDelete = existing.filter((row) => !keep.has(row.path));
  for (const row of toDelete) {
    // oxlint-disable-next-line no-await-in-loop -- sequential prune; set is typically empty or 1-2 rows
    await db.delete(sourceChangelogFiles).where(eq(sourceChangelogFiles.id, row.id));
    logEvent("info", {
      component: "cron-poll-fetch",
      event: "changelog-file-pruned",
      sourceSlug: source.slug,
      path: row.path,
    });
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

async function fetchGitHub(
  source: Source,
  token?: string,
  opts?: { repoUrl?: string },
): Promise<RawRelease[]> {
  const meta = getSourceMeta(source);
  const repoUrl = opts?.repoUrl ?? effectiveGitHubUrl(source, meta);
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
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
    prerelease: boolean;
  }> = await res.json();

  // Override mode: rewrite release URLs through the template so dedup against
  // existing scrape rows lines up via UNIQUE(source_id, url). See #831.
  const overrideMode = meta.githubUrl != null && meta.githubUrl.length > 0;

  return data.slice(0, 200).map((rel) => {
    const url =
      overrideMode && rel.tag_name
        ? synthesizeReleaseUrl({
            sourceUrl: source.url,
            version: rel.tag_name,
            template: meta.releaseUrlTemplate,
          })
        : rel.html_url;
    return {
      version: rel.tag_name,
      title: rel.name || rel.tag_name,
      content: rel.body || "",
      url,
      publishedAt: rel.published_at ? new Date(rel.published_at) : undefined,
      prerelease: rel.prerelease === true,
    };
  });
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
        summary: releases.summary,
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

type ChunkOffsetUpdate = DiffResult["unchanged"][number];

/**
 * Build the park + final UPDATE statements for unchanged chunks. The schema
 * has UNIQUE(file, offset), so when a prepend shifts every chunk a one-pass
 * UPDATE loop can briefly collide with a sibling chunk that hasn't moved
 * yet. Park each row at a unique negative offset first, then set the final
 * offsets. Returned as plain statements so callers can fold them into a
 * larger `db.batch`.
 */
function buildChunkOffsetUpdateStatements(
  db: ReturnType<typeof drizzle>,
  unchanged: ReadonlyArray<ChunkOffsetUpdate>,
) {
  if (unchanged.length === 0) return [];
  const parkOps = unchanged.map((u, i) =>
    db
      .update(sourceChangelogChunks)
      .set({ offset: -1 - i })
      .where(eq(sourceChangelogChunks.id, u.id)),
  );
  const finalOps = unchanged.map((u) =>
    db
      .update(sourceChangelogChunks)
      .set({
        offset: u.chunk.offset,
        length: u.chunk.length,
        tokens: u.chunk.tokens,
        heading: u.chunk.heading,
      })
      .where(eq(sourceChangelogChunks.id, u.id)),
  );
  return [...parkOps, ...finalOps];
}

/**
 * Wrapper that runs the park + final updates as a single atomic batch.
 * Kept exported for direct unit tests that exercise the offset-shift fix
 * in isolation; production code calls {@link applyOnDiff} instead.
 */
export async function applyChunkOffsetUpdates(
  db: ReturnType<typeof drizzle>,
  unchanged: ReadonlyArray<ChunkOffsetUpdate>,
): Promise<void> {
  const ops = buildChunkOffsetUpdateStatements(db, unchanged);
  if (ops.length === 0) return;
  await db.batch(ops as [(typeof ops)[number], ...typeof ops]);
}

/**
 * Apply a chunk-diff to D1 in a single atomic batch: stale rows are deleted,
 * unchanged rows park-and-shift to their new offsets, and new rows are
 * inserted with `vectorId = null` / `embeddedAt = null`. The follow-up
 * UPDATE that sets `vectorId` runs in {@link setChunkVectorIds} after the
 * Vectorize upsert confirms — see issue #620 for why this split exists.
 *
 * Folding the three phases into one `db.batch` means a crash mid-flight
 * leaves D1 unchanged rather than stranding stale rows that block
 * subsequent inserts via the `UNIQUE(source_changelog_file_id, offset)`
 * constraint.
 */
export async function applyOnDiff(
  db: ReturnType<typeof drizzle>,
  params: {
    fileId: string;
    sourceId: string;
    diff: DiffResult;
  },
): Promise<void> {
  const { fileId, sourceId, diff } = params;

  const deleteOps = [];
  if (diff.toDelete.length > 0) {
    const ids = diff.toDelete.map((d) => d.id);
    // D1 caps bound parameters per statement at 100; RELEASES_ID_IN_CHUNK_SIZE
    // (90) leaves headroom for the wrapping statement.
    for (let i = 0; i < ids.length; i += RELEASES_ID_IN_CHUNK_SIZE) {
      const slice = ids.slice(i, i + RELEASES_ID_IN_CHUNK_SIZE);
      deleteOps.push(
        db.delete(sourceChangelogChunks).where(inArray(sourceChangelogChunks.id, slice)),
      );
    }
  }

  // Fold both buckets into one park-and-shift batch to avoid
  // `UNIQUE(file, offset)` collisions between them mid-update.
  const updateOps = buildChunkOffsetUpdateStatements(db, [...diff.unchanged, ...diff.toReembed]);

  const insertOps = [];
  if (diff.toInsert.length > 0) {
    const values = diff.toInsert.map((chunk) => ({
      sourceChangelogFileId: fileId,
      sourceId,
      offset: chunk.offset,
      length: chunk.length,
      tokens: chunk.tokens,
      contentHash: chunk.contentHash,
      heading: chunk.heading,
      vectorId: null,
      embeddedAt: null,
    }));
    for (let i = 0; i < values.length; i += CHANGELOG_CHUNK_INSERT_CHUNK_SIZE) {
      insertOps.push(
        db
          .insert(sourceChangelogChunks)
          .values(values.slice(i, i + CHANGELOG_CHUNK_INSERT_CHUNK_SIZE)),
      );
    }
  }

  const ops = [...deleteOps, ...updateOps, ...insertOps];
  if (ops.length === 0) return;
  await db.batch(ops as [(typeof ops)[number], ...typeof ops]);
}

/**
 * Follow-up UPDATE that promotes staged chunks (`vectorId = null` after
 * {@link applyOnDiff}) to "embedded" once the Vectorize upsert confirms.
 * Matches by `(source_changelog_file_id, content_hash)` — `applyOnDiff`
 * stages each new chunk with its content hash, and `buildVectorId` is
 * deterministic so the vectorId lines up.
 *
 * Invariant: the WHERE clause may match more than one row when a file has
 * multiple chunks with identical text. That is intentional — buildVectorId
 * is deterministic and the Vectorize upsert is idempotent on that vectorId.
 *
 * Failure here is recoverable: the chunks stay with `vectorId = null` and
 * the existing embed-backfill job picks them up. The next embed run
 * produces the same vectorId and the upsert is idempotent. See #620.
 */
export async function setChunkVectorIds(
  db: ReturnType<typeof drizzle>,
  params: {
    fileId: string;
    now: string;
    embedded: EmbeddedChunk[];
  },
): Promise<void> {
  const { fileId, now, embedded } = params;
  if (embedded.length === 0) return;

  const ops = embedded.map((e) =>
    db
      .update(sourceChangelogChunks)
      .set({ vectorId: e.vectorId, embeddedAt: now })
      .where(
        and(
          eq(sourceChangelogChunks.sourceChangelogFileId, fileId),
          eq(sourceChangelogChunks.contentHash, e.chunk.contentHash),
        ),
      ),
  );
  await db.batch(ops as [(typeof ops)[number], ...typeof ops]);
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
    onDiff: async ({ diff }) => {
      await applyOnDiff(db, {
        fileId: file.fileId,
        sourceId: source.id,
        diff,
      });
    },
    onVectorsCommitted: async ({ committed }) => {
      await setChunkVectorIds(db, {
        fileId: file.fileId,
        now: new Date().toISOString(),
        embedded: committed,
      });
    },
  });
}
