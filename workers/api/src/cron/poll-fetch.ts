import { eq, and, or, sql, isNull, inArray } from "drizzle-orm";
import { createDb, type D1Db } from "../db.js";
import {
  sources,
  sourcesVisible,
  releases,
  fetchLog,
  sourceChangelogFiles,
  sourceChangelogChunks,
  knowledgePages,
  organizations,
} from "@buildinternet/releases-core/schema";
import { countTokensSafe, computeContentSize } from "@buildinternet/releases-core/tokens";
import type { Source } from "@buildinternet/releases-core/schema";
import {
  headCheckUrl,
  bodyHashCheck,
  fetchAndParseFeed,
  filterByCategoryAllow,
  filterByKeywordAllow,
  filterByUrlDeny,
  getSourceMeta,
  isGitHubFetched,
  effectiveGitHubUrl,
  synthesizeReleaseUrl,
  FEED_4XX_INVALIDATE_THRESHOLD,
  CLEARED_FEED_FIELDS,
  extractMediaFromMarkdown,
} from "@releases/adapters/feed.js";
import type { SourceMetadata, ChangeStatus } from "@releases/adapters/feed.js";
import { isAppStoreFetched, isVideoFetched } from "@releases/adapters/source-meta";
import { TIER_INTERVALS } from "@releases/adapters/fetch-plan";
import {
  resolveAppStore,
  appStoreCoordFromSource,
  mapListingToRawReleases,
} from "@releases/adapters/appstore";
import { fetchHelpCenter } from "@releases/adapters/helpcenter";
import { refreshAppStoreListing } from "../lib/appstore-materialize.js";
import { fetchAndParseVideoFeed, resolveVideoProvider } from "@releases/adapters/video";
import { loadFetchQuirks, type FetchQuirk } from "@releases/ai-internal/playbook";
import { FeedHttpError, isTransientFeedHttpStatus } from "@releases/lib/errors";
import { contentHash } from "@releases/adapters/content-hash";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { fetchCloudflareMarkdown } from "@releases/adapters/cloudflare";
import { getSecret } from "@releases/lib/secrets";
import type { RawRelease } from "@releases/adapters/types.js";
import {
  discoverChangelogPaths,
  buildGitHubHeaders,
  parseOwnerRepo,
} from "@releases/adapters/github-discovery";
import { CHANGELOG_MAX_FILES, truncateToByteCap } from "@releases/adapters/github";
import { isPrereleaseVersion } from "@buildinternet/releases-core/prerelease";
import { computeVersionSort } from "@buildinternet/releases-core/version-sort";
import { dedupeByExistingTitle } from "@buildinternet/releases-core/title-dedup";
import { selectExistingReleaseKeys } from "../lib/title-dedup.js";
import { startDeterministicUpdate, type UpdateDispatchEnv } from "../lib/update-dispatch.js";
import { notifyOrgDrain } from "../lib/org-drain-notify.js";
import type { OrgActor } from "../org-actor.js";
import { normalizeMediaUrl } from "@releases/rendering/media-url.js";
import { filterJunkMedia } from "@releases/rendering/media-filter.js";
import { detectInlineVideos } from "@releases/rendering/video-embed.js";
import {
  processMediaForR2,
  selectExistingReleaseUrls,
  type MediaTransformBinding,
} from "../lib/media-ingest.js";
import {
  embedAndUpsertChangelogFile,
  type EmbeddedChunk,
} from "@releases/search/embed-changelog-pipeline.js";
import type { DiffResult } from "@releases/search/embed-changelogs.js";
import { buildEmbedConfig } from "@releases/search/embed-config.js";
import { runWithConcurrency } from "../lib/concurrency.js";
import type { VectorizeIndex } from "@releases/search/vector-search.js";
import { embedAndUpsertReleases } from "@releases/search/embed-releases.js";
import { fetchEffectiveCategoryBySourceIds } from "@releases/core-internal/effective-category";
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
import { logSwallowed } from "../lib/log-swallowed.js";
import { classifyDbError, dbErrorLogFields } from "@releases/lib/db-errors";
import { makeBotFetch } from "../lib/web-bot-auth-fetch.js";
import { FLAGS, flag } from "@releases/lib/flags";
import {
  classifyMarketing,
  type MarketingClassifierResult,
} from "@releases/ai-internal/marketing-classifier";
import { resolveMarketingModel, type TextModelEnv } from "../lib/text-model.js";
import { assessFeedDepth, DEFAULT_FEED_THIN_CHARS } from "@releases/adapters/feed-depth";
import {
  enrichNewThinItems,
  enrichFeedItem,
  buildEnrichDeps,
  parsePositiveInt,
  type EnrichOutcome,
} from "./feed-enrich.js";

// ── Tier intervals (hours) ──
// `TIER_INTERVALS` is sourced from @releases/adapters/fetch-plan (imported above)
// so the dev fetch-plan endpoint's displayed cadence can't drift from what this
// cron actually enforces.

type PollTier = keyof typeof TIER_INTERVALS;

const POLL_CONCURRENCY = 5;
const FETCH_CONCURRENCY = 3;

// ── Main entry point ──

export async function pollAndFetch(
  env: FetchOneEnv &
    InvalidationEnv & {
      DB: D1Database;
      CRON_ENABLED?: string;
    },
): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "cron-poll-fetch", event: "cron-disabled" });
    return;
  }

  const db = createDb(env.DB);
  const now = new Date();
  // Scrape/agent change-detection (#517) is always on now.
  const changeDetectEnabled = true;

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

  // Build the signing fetch once per fire — `createSigningFetch` returns a
  // stateless closure, so sharing it across concurrent sources is safe and
  // avoids one Secrets Store read per source when signing is enabled.
  const signedFetch = await makeBotFetch(env);

  // Poll phase: HEAD checks
  const pollResults = await runWithConcurrency(dueSources, POLL_CONCURRENCY, async (source) => {
    return pollOne(db, source, now, {
      changeDetectEnabled,
      playbookNotes: source.orgId ? (playbookNotesByOrg.get(source.orgId) ?? null) : null,
      signedFetch,
    });
  });

  // Fetch phase: fetch changed feed/github sources, plus scrape sources
  // that have a discovered feed (their fetchOne path prefers that feed over
  // crawl+AI, so cost is identical to a native feed source).
  // Feed sources missing feedUrl or feedType are skipped here — calling
  // fetchOne would log a fetch_log error row and drive backoff. They need
  // metadata repair (re-discovery), not repeated error accumulation. Same
  // approach as the scrape-without-feedUrl branch below.
  const fetchable = pollResults
    .filter((r) => r.changed)
    .map((r) => r.source)
    .filter((s) => {
      if (s.type === "feed") {
        const m = getSourceMeta(s);
        if (!m.feedUrl || !m.feedType) {
          logEvent("warn", {
            component: "cron-poll-fetch",
            event: "skip-feed-broken-metadata",
            sourceSlug: s.slug,
          });
          return false;
        }
        return true;
      }
      if (s.type === "scrape") {
        const m = getSourceMeta(s);
        if (!m.feedUrl || !m.feedType) {
          if (m.feedUrl) {
            // feedUrl present but feedType missing — same broken-metadata state
            // as the feed branch above; skip rather than driving backoff.
            logEvent("warn", {
              component: "cron-poll-fetch",
              event: "skip-feed-broken-metadata",
              sourceSlug: s.slug,
            });
          }
          return false;
        }
        return true;
      }
      if (s.type === "appstore") return true;
      if (isVideoFetched(s)) {
        const m = getSourceMeta(s);
        if (!m.feedUrl) {
          logEvent("warn", {
            component: "cron-poll-fetch",
            event: "skip-video-broken-metadata",
            sourceSlug: s.slug,
          });
          return false;
        }
        return true;
      }
      return s.type === "github";
    });

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
      const r = await fetchOne(db, source, env, { signedFetch });
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
      cause: lastInsertingSource ?? "cron",
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
  db: D1Db,
  now: Date,
  opts?: { changeDetectEnabled?: boolean },
): Promise<Source[]> {
  const notPaused = sql`${sourcesVisible.fetchPriority} != 'paused'`;
  // Include sources that have a feed URL OR are GitHub type (GitHub sources
  // don't store a feedUrl — they use the GitHub releases API directly), OR
  // carry a `metadata.githubUrl` fetch override (#831 — scrape sources opting
  // into the GitHub releases API while keeping a human-readable canonical URL).
  // Also include scrape/agent sources with no feedUrl (#517) — `pollOne` routes
  // those to a detector from the playbook's `fetchQuirks` (unreliable class is a
  // no-op, so the widened filter doesn't explode poll volume).
  const pollable = opts?.changeDetectEnabled
    ? sql`(json_extract(${sourcesVisible.metadata}, '$.feedUrl') IS NOT NULL OR json_extract(${sourcesVisible.metadata}, '$.githubUrl') IS NOT NULL OR ${sourcesVisible.type} = 'github' OR ${sourcesVisible.type} = 'appstore' OR ${sourcesVisible.type} IN ('scrape','agent'))`
    : sql`(json_extract(${sourcesVisible.metadata}, '$.feedUrl') IS NOT NULL OR json_extract(${sourcesVisible.metadata}, '$.githubUrl') IS NOT NULL OR ${sourcesVisible.type} = 'github' OR ${sourcesVisible.type} = 'appstore')`;

  // Build OR conditions for each tier using sql template to avoid enum type issues
  const tierConditions = (Object.keys(TIER_INTERVALS) as PollTier[]).map((tier) => {
    const hours = TIER_INTERVALS[tier];
    const cutoff = new Date(now.getTime() - hours * 3600_000).toISOString();
    return and(
      sql`${sourcesVisible.fetchPriority} = ${tier}`,
      or(isNull(sourcesVisible.lastPolledAt), sql`${sourcesVisible.lastPolledAt} < ${cutoff}`),
    );
  });

  // Exclude sources whose org has fetch_paused = true (#1057). Use a NOT IN
  // subquery rather than a JOIN so the outer .select() shape stays Source[]
  // without needing column projection gymnastics.
  const pausedOrgIds = db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.fetchPaused, true));

  const orgNotFetchPaused = sql`${sourcesVisible.orgId} NOT IN (${pausedOrgIds})`;

  // Honor the smart-fetch exponential backoff. The no-change / error paths in
  // `fetchOne` stamp `nextFetchAfter` (1h→48h on repeat no_change, up to 72h on
  // errors); without this predicate the hourly cron re-polled on the tier
  // interval alone and the backoff only gated the `?mode=stale` agent endpoint.
  // A null (never backed off) or past `nextFetchAfter` is ready to poll.
  const nowIso = now.toISOString();
  const backoffReady = sql`(${sourcesVisible.nextFetchAfter} IS NULL OR ${sourcesVisible.nextFetchAfter} <= ${nowIso})`;

  // Firecrawl-owned sources are ingested via the inbound webhook + workflow, not
  // the poll cron — exclude them from BOTH the inline and workflow fan-out paths
  // (this query gates both). enabled === true → json_extract returns 1; absent → NULL.
  const notFirecrawl = sql`(json_extract(${sourcesVisible.metadata}, '$.firecrawl.enabled') IS NULL OR json_extract(${sourcesVisible.metadata}, '$.firecrawl.enabled') != 1)`;

  return db
    .select()
    .from(sourcesVisible)
    .where(
      and(
        pollable,
        notPaused,
        orgNotFetchPaused,
        backoffReady,
        notFirecrawl,
        or(...tierConditions),
      ),
    );
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
  db: D1Db,
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
  db: D1Db,
  source: Source,
  now: Date,
  opts?: {
    changeDetectEnabled?: boolean;
    playbookNotes?: string | null;
    signedFetch?: typeof fetch;
    /**
     * When present, scrape/agent sources self-flag `changeDetectedAt` for the
     * OrgActor drain instead of waiting for the force-drain cron (#518). Absent
     * ⇒ today's behavior (unreliable/absent detector is a no-op).
     */
    drainSelfFlag?: { staleHours: number };
    /**
     * When present, a scrape/agent poll that flags the source arms the per-org
     * `OrgActor` drain immediately via this namespace (#1946 phase 2) rather than
     * waiting for the source's next `SourceActor` alarm to notice the flag. Absent
     * ⇒ no eager notify (the alarm backstop still covers it).
     */
    drainOrgActor?: DurableObjectNamespace<OrgActor>;
  },
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

  // App Store sources have no cheap HEAD probe; the lookup is a single tiny
  // JSON GET, so mark changed and let fetchOne do the one lookup + dedup
  // (mirrors the GitHub branch above).
  if (isAppStoreFetched(source)) {
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
    const scrapeResult = await pollScrapeOrAgentByQuirk(
      db,
      source,
      meta,
      now,
      opts.playbookNotes ?? null,
      opts.signedFetch,
      opts.drainSelfFlag,
    );
    // Eager drain-arm (#1946 phase 2): a `changed` result here means this poll
    // just set `changeDetectedAt` for the OrgActor drain (this is exactly the
    // scrape/agent-no-feed drain-candidate shape). Arm the drain now — an
    // in-worker DO RPC — instead of waiting up to a full tier interval for the
    // next SourceActor alarm to notice the flag. Best-effort + idempotent; the
    // SourceActor alarm remains the at-least-once backstop.
    if (scrapeResult.changed && source.orgId) {
      await notifyOrgDrain(opts.drainOrgActor, source.orgId, "poll-and-fetch-workflow");
    }
    return scrapeResult;
  }

  if (!meta.feedUrl) {
    await db.update(sources).set({ lastPolledAt: nowIso }).where(eq(sources.id, source.id));
    return { source, changed: false };
  }

  try {
    const result = await headCheckUrl(
      meta.feedUrl,
      {
        etag: meta.feedEtag,
        lastModified: meta.feedLastModified,
        contentLength: meta.feedContentLength,
      },
      opts?.signedFetch,
    );

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
 * Force-drain staleness test (#518 → producer). A source is stale when it has
 * never fetched or its last successful fetch is older than `staleHours`.
 */
function isStale(lastFetchedAt: string | null, now: Date, staleHours: number): boolean {
  if (!lastFetchedAt) return true;
  const t = Date.parse(lastFetchedAt);
  return !Number.isFinite(t) || t < now.getTime() - staleHours * 3600_000;
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
  db: D1Db,
  source: Source,
  meta: SourceMetadata,
  now: Date,
  playbookNotes: string | null,
  signedFetch?: typeof fetch,
  drainSelfFlag?: { staleHours: number },
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
    const staleFlag =
      drainSelfFlag != null && isStale(source.lastFetchedAt, now, drainSelfFlag.staleHours);
    const flagged = changed || staleFlag;
    const updates: Record<string, unknown> = { lastPolledAt: nowIso };
    if (Object.keys(metaUpdates).length > 0) {
      updates.metadata = JSON.stringify({ ...meta, ...metaUpdates });
    }
    if (flagged) updates.changeDetectedAt = nowIso;
    await db.update(sources).set(updates).where(eq(sources.id, source.id));
    return flagged;
  };

  if (!quirk || quirk.changeDetector === "unreliable") {
    // Force-drain producer (#518): flag when the detector can never self-signal
    // (unreliable) or the source is stale. Absent quirk only flags on staleness.
    const unreliable = quirk?.changeDetector === "unreliable";
    const flagged =
      drainSelfFlag != null &&
      (unreliable || isStale(source.lastFetchedAt, now, drainSelfFlag.staleHours));
    const updates: Record<string, unknown> = { lastPolledAt: nowIso };
    if (flagged) updates.changeDetectedAt = nowIso;
    await db.update(sources).set(updates).where(eq(sources.id, source.id));
    logOutcome(quirk?.changeDetector ?? "none", flagged ? "changed" : "skipped");
    return { source, changed: flagged };
  }

  const probeUrl = quirk.changeProbeUrl ?? source.url;
  const detector = quirk.changeDetector;

  try {
    let metaUpdates: Partial<SourceMetadata>;
    let status: ChangeStatus;

    switch (detector) {
      case "body-hash":
      case "body-hash-filtered": {
        const result = await bodyHashCheck(
          probeUrl,
          meta.pageContentHash,
          { filter: detector === "body-hash-filtered" },
          signedFetch,
        );
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
        const result = await headCheckUrl(
          probeUrl,
          {
            etag: meta.pageEtag,
            lastModified: meta.pageLastModified,
            contentLength: meta.pageContentLength,
          },
          signedFetch,
        );
        metaUpdates = {};
        if (result.etag) metaUpdates.pageEtag = result.etag;
        if (result.lastModified) metaUpdates.pageLastModified = result.lastModified;
        if (result.contentLength) metaUpdates.pageContentLength = result.contentLength;
        status = result.status;
        break;
      }
    }

    const changed = await persistOutcome(metaUpdates, status);
    const detectedChange = status === "changed" || status === "unknown";
    logOutcome(
      detector,
      changed ? "changed" : "unchanged",
      changed && !detectedChange ? "reason=stale" : undefined,
    );
    return { source, changed };
  } catch (err) {
    // Force-drain equivalence (#518): a persistently-erroring detector still
    // strands a source; self-flag once stale so the OrgActor drains it, exactly
    // as the retired force-drain cron's stale rule did.
    const flagged =
      drainSelfFlag != null && isStale(source.lastFetchedAt, now, drainSelfFlag.staleHours);
    const updates: Record<string, unknown> = { lastPolledAt: nowIso };
    if (flagged) updates.changeDetectedAt = nowIso;
    await db.update(sources).set(updates).where(eq(sources.id, source.id));
    logOutcome(detector, "error", `err="${err instanceof Error ? err.message : err}"`);
    return { source, changed: flagged };
  }
}

// ── Fetch one source ──

type FetchOneBase = {
  releasesFound: number;
  releasesInserted: number;
  durationMs: number;
  /** IDs of newly-inserted release rows (empty when nothing changed). */
  insertedIds?: string[];
};

export type FetchOneResult =
  | (FetchOneBase & { status: "success" })
  | (FetchOneBase & { status: "no_change" })
  | (FetchOneBase & {
      status: "delegated";
      /** Session ID minted by `startDeterministicUpdate` for the delegated run. */
      sessionId: string;
    })
  | (FetchOneBase & {
      status: "error";
      error: string;
      /**
       * True when the error is a transient feed rate-limit/timeout (429/408).
       * fetchOne has already stamped an exponential `nextFetchAfter` backoff
       * (honoring Retry-After); the workflow uses this to treat the failure as
       * expected — no retry storm, no failure-alert email.
       */
      rateLimited?: boolean;
    })
  | (FetchOneBase & { status: "dry_run" });

export const DEFAULT_FETCH_MAX_ENTRIES = 200;

// UpdateDispatchEnv carries the deterministic-update dispatch bindings (#1946):
// LATEST_CACHE (kill switch + spend-cap counters), FLAGS, SOURCE_ACTOR (per-
// source lock), STATUS_HUB, DETERMINISTIC_UPDATE_WORKFLOW, and the MA_* cap
// vars. Summary-only crawl-enabled feeds delegate through it — see
// {@link shouldDelegateToCrawl} / {@link delegateScrapeToUpdateWorkflow}.
export interface FetchOneEnv extends IndexNowEnv, TextModelEnv, UpdateDispatchEnv {
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
  // Feed content enrichment. Kill switch + cap as strings (Workers env vars are
  // strings). CF creds are bound from the same Secrets Store entries the
  // discovery worker uses; absent => render escalation is skipped.
  FEED_ENRICH_ENABLED?: string;
  FEED_ENRICH_MAX_PER_FIRE?: string;
  FEED_THIN_CHARS?: string;
  CLOUDFLARE_ACCOUNT_ID?: { get(): Promise<string> };
  CLOUDFLARE_API_TOKEN?: { get(): Promise<string> };
  WEB_BOT_AUTH_ENABLED?: string;
  WEB_BOT_AUTH_PRIVATE_KEY?: { get(): Promise<string> };
  // Ingest-time R2 media upload (#1177). Kill switch as a string (Workers env
  // vars are strings); default off. `MEDIA` is the `released-media` R2 bucket
  /** Scrape title-dedup kill switch (#1410); default off (i.e. dedup ON). */
  SCRAPE_TITLE_DEDUP_DISABLED?: string;
  MEDIA?: R2Bucket;
  // GIF→MP4 ingest transcode (#1368). When the binding is present and the flag is
  // on, an ingested `image/gif` is stored as a small MP4 instead of the raw GIF.
  MEDIA_TRANSFORM?: MediaTransformBinding;
  MEDIA_GIF_TRANSCODE_ENABLED?: string;
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
 * spinning up a worker environment.
 */
export function shouldDelegateToCrawl(
  source: Source,
  meta: SourceMetadata,
  rawReleases: readonly RawRelease[],
): boolean {
  if (source.type !== "scrape") return false;
  if (meta.crawlEnabled !== true) return false;
  if (rawReleases.length === 0) return false;
  if (meta.feedContentDepth === "summary-only" || meta.feedContentDepth === "anchor-fragment")
    return true;
  // Treat an all-empty-content batch the same as an explicit summary-only
  // tag: the feed didn't actually deliver bodies, regardless of what it
  // self-described as. Whitespace-only counts as empty.
  return rawReleases.every((r) => !r.content || r.content.trim() === "");
}

/**
 * Hand the source off to a deterministic update run (#1946) and return a
 * no-rows result. The run executes async as a `DeterministicUpdateWorkflow`
 * instance in this worker — when it completes, `scrapeFetch` writes its own
 * `fetch_log` rows and source-counter updates. Returning a synthetic
 * `no_change` keeps the workflow step from racing it (we don't yet know what
 * changed) and avoids double-bumping counters.
 *
 * The run needs `company` (used for the StatusHub session row), which means we
 * have to look up the org name from `source.orgId`. Failing that lookup is
 * surfaced as an error so the workflow step retries — an orphaned source is
 * an upstream bug we'd rather see in logs than silently swallow.
 */
/**
 * Refusal-cooldown horizon for {@link delegateScrapeToUpdateWorkflow}. Shorter
 * than the 1h success cooldown (`DELEGATION_COOLDOWN_MS`) because a refusal
 * usually clears sooner — a 15-min scrape lease, an operator kill-switch flip,
 * or the daily spend-cap reset — while still being long enough to stop a refused
 * source from re-firing delegation every poll tick.
 */
const DELEGATION_REFUSAL_COOLDOWN_MS = 30 * 60_000;

export async function delegateScrapeToUpdateWorkflow(
  db: D1Db,
  source: Source,
  env: FetchOneEnv,
): Promise<FetchOneResult> {
  const start = Date.now();

  if (!env.DETERMINISTIC_UPDATE_WORKFLOW) {
    const durationMs = Date.now() - start;
    logEvent("warn", {
      component: "cron-poll-fetch",
      event: "crawl-delegation-missing-workflow",
      sourceSlug: source.slug,
      orgId: source.orgId,
      durationMs,
    });
    return {
      releasesFound: 0,
      releasesInserted: 0,
      durationMs,
      status: "error" as const,
      error: "Cannot delegate: DETERMINISTIC_UPDATE_WORKFLOW binding not configured",
    };
  }

  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, source.orgId))
    .limit(1);

  if (!org) {
    const durationMs = Date.now() - start;
    logEvent("warn", {
      component: "cron-poll-fetch",
      event: "crawl-delegation-org-missing",
      sourceSlug: source.slug,
      orgId: source.orgId,
      durationMs,
    });
    return {
      releasesFound: 0,
      releasesInserted: 0,
      durationMs,
      status: "error" as const,
      error: `Cannot delegate: org ${source.orgId} not found`,
    };
  }

  const result = await startDeterministicUpdate(env, {
    sourceIdentifiers: [source.id],
    company: org.name,
    orgId: source.orgId,
    correlationId: `summary-only-delegation:${source.slug}`,
  });

  const durationMs = Date.now() - start;

  if (!result.ok) {
    // Refused dispatch (spend cap / kill switch / per-source lock / binding
    // unavailable). Unlike a successful handoff, nothing downstream is now
    // handling this source, so we leave `changeDetectedAt` set for it to retry —
    // but a bare refusal leaves `nextFetchAfter` null, so the source stays "due"
    // and re-attempts delegation on every poll tick: the same runaway the success
    // path guards against (the $20 Notion loop, 2026-05-18). Stamp a short
    // `nextFetchAfter` refusal cooldown to pace the retries — the refusal
    // typically clears within it (a 15-min scrape lease, an operator kill-switch
    // toggle, or the UTC-midnight spend-cap reset). We do NOT bump
    // `consecutiveNoChange`: the source isn't unchanged, just deferred, so
    // exponential no-change backoff doesn't apply.
    try {
      await db
        .update(sources)
        .set({
          nextFetchAfter: new Date(Date.now() + DELEGATION_REFUSAL_COOLDOWN_MS).toISOString(),
        })
        .where(eq(sources.id, source.id));
    } catch (err) {
      logEvent("warn", {
        component: "cron-poll-fetch",
        event: "crawl-delegation-refusal-cooldown-failed",
        sourceSlug: source.slug,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    logEvent("warn", {
      component: "cron-poll-fetch",
      event: "crawl-delegation-failed",
      sourceSlug: source.slug,
      error: result.message,
      durationMs,
    });
    return {
      releasesFound: 0,
      releasesInserted: 0,
      durationMs,
      status: "error" as const,
      error: result.message,
    };
  }

  // Write bookkeeping so the source isn't immediately re-picked while the MA
  // session is still in flight. Without this, `changeDetectedAt` stays set
  // and `nextFetchAfter` stays null, so the next poll-fetch tick re-fires
  // delegation — that's the runaway loop that burned ~$20 in Haiku on
  // 2026-05-18 when a manual /fetch seeded one Notion session and the
  // workflow kept re-spawning. The MA session writes the real fetch_log row
  // (with actual `releasesInserted` count) when it completes; this synthetic
  // row only exists to take the source out of the "due" queue.
  //
  // 1-hour fixed cooldown: longer than any reasonable MA session runtime
  // (typical ~2 min), shorter than the normal-tier 4h base interval so we
  // don't disrupt the source's natural cadence. We don't touch
  // `consecutiveNoChange` because the source isn't actually unchanged — we
  // just delegated; exponential backoff doesn't apply.
  const DELEGATION_COOLDOWN_MS = 60 * 60_000;
  // db.batch is atomic — both writes commit together or neither does. A
  // half-written state (cooldown set without the matching fetch_log entry,
  // or vice versa) would either drop the source from observability or leave
  // the loop window open.
  const ops = [
    db.insert(fetchLog).values({
      sourceId: source.id,
      sessionId: result.sessionId,
      releasesFound: 0,
      releasesInserted: 0,
      durationMs,
      status: "no_change",
    }),
    db
      .update(sources)
      .set({
        nextFetchAfter: new Date(Date.now() + DELEGATION_COOLDOWN_MS).toISOString(),
        changeDetectedAt: null,
      })
      .where(eq(sources.id, source.id)),
  ];
  await db.batch(ops as [(typeof ops)[number], ...typeof ops]);

  logEvent("info", {
    component: "cron-poll-fetch",
    event: "crawl-delegation-handoff",
    sourceSlug: source.slug,
    sessionId: result.sessionId,
    durationMs,
  });

  return {
    releasesFound: 0,
    releasesInserted: 0,
    durationMs,
    status: "delegated" as const,
    sessionId: result.sessionId,
  };
}

/** Just the Browser Rendering credentials {@link renderCheckOne} needs. */
export interface RenderCheckEnv {
  CLOUDFLARE_ACCOUNT_ID?: { get(): Promise<string | null> } | { get(): Promise<string> };
  CLOUDFLARE_API_TOKEN?: { get(): Promise<string | null> } | { get(): Promise<string> };
}

/** Result of a render dry-run probe ({@link renderCheckOne}). */
export interface RenderCheckResult {
  status: "dry_run" | "error";
  /** True when the headless render returned non-empty markdown. */
  rendered: boolean;
  /** Distinct same-origin candidate links discovered on the rendered index. */
  candidateCount: number;
  /** A few example candidate URLs, for the operator to eyeball. */
  sampleUrls: string[];
  durationMs: number;
  error?: string;
}

/** Markdown links `](href)` and bare http(s) URLs. Used with `matchAll` (which
 * resets `lastIndex` per call), so the shared `g`-flagged instance is safe. */
const CANDIDATE_LINK_RE = /\]\((https?:\/\/[^)\s]+)\)|(?<![(\w])(https?:\/\/[^)\s\]]+)/g;

/**
 * Markdown-link + bare-URL extraction, restricted to the index's own origin and
 * excluding the index URL itself. This is a coarse "did the render expose
 * release links" signal, not a parser — nav/footer links on-origin count too,
 * so a healthy index reads as "dozens of candidates" and a broken (empty-shell)
 * render reads as ~0. Exported for unit testing.
 */
export function extractCandidateLinks(markdown: string, baseUrl: string): string[] {
  let origin: string;
  let normalizedBase: string;
  try {
    const u = new URL(baseUrl);
    origin = u.origin;
    normalizedBase = u.href.replace(/#.*$/, "").replace(/\/$/, "");
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const m of markdown.matchAll(CANDIDATE_LINK_RE)) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;
    let href: string;
    try {
      const u = new URL(raw);
      if (u.origin !== origin) continue;
      href = u.href.replace(/#.*$/, "").replace(/\/$/, "");
    } catch {
      continue;
    }
    if (href === normalizedBase) continue;
    found.add(href);
  }
  return [...found];
}

/**
 * Render dry-run probe (#1528). Renders a client-rendered scrape source's index
 * once via Cloudflare Browser Rendering and reports how many candidate release
 * links the rendered page exposes — WITHOUT the managed-agent extraction loop
 * (no Haiku/Sonnet, no discovery-worker session). The cheap "can the cron's
 * render actually see releases here, or is it hitting an empty JS shell?" check
 * that onboarding a `renderRequired` source previously had no way to answer.
 *
 * Writes a `dry_run` fetch_log row so the probe is visible in observability but
 * never mutates source state or inserts releases.
 */
export async function renderCheckOne(
  db: D1Db,
  source: Source,
  env: RenderCheckEnv,
): Promise<RenderCheckResult> {
  const start = Date.now();
  // getSecret throws on a transient Secrets Store failure; soft-fail to null so
  // absent/unreachable creds surface as a clean error rather than an exception.
  // The two bindings are independent — resolve them concurrently.
  const [accountId, apiToken] = await Promise.all([
    getSecret(env.CLOUDFLARE_ACCOUNT_ID).catch(() => null),
    getSecret(env.CLOUDFLARE_API_TOKEN).catch(() => null),
  ]);
  if (!accountId || !apiToken) {
    const durationMs = Date.now() - start;
    logEvent("warn", {
      component: "cron-poll-fetch",
      event: "render-check-no-creds",
      sourceSlug: source.slug,
      durationMs,
    });
    return {
      status: "error",
      rendered: false,
      candidateCount: 0,
      sampleUrls: [],
      durationMs,
      error: "Cloudflare Browser Rendering credentials not configured",
    };
  }

  const markdown = await fetchCloudflareMarkdown(source.url, accountId, apiToken).catch(() => null);
  const durationMs = Date.now() - start;
  const rendered = !!markdown?.trim();
  const candidates = rendered ? extractCandidateLinks(markdown!, source.url) : [];

  // A dry_run fetch_log row keeps the probe visible without touching source
  // state. releasesFound carries the candidate count; nothing is inserted.
  await db
    .insert(fetchLog)
    .values({
      sourceId: source.id,
      sessionId: null,
      releasesFound: candidates.length,
      releasesInserted: 0,
      durationMs,
      status: "dry_run",
    })
    .catch(logSwallowed("cron-poll-fetch", "fetch-log-write-failed", { sourceSlug: source.slug }));

  logEvent(rendered ? "info" : "warn", {
    component: "cron-poll-fetch",
    event: "render-check",
    sourceSlug: source.slug,
    rendered,
    candidateCount: candidates.length,
    durationMs,
  });

  return {
    status: "dry_run",
    rendered,
    candidateCount: candidates.length,
    sampleUrls: candidates.slice(0, 5),
    durationMs,
  };
}

/**
 * No-change bookkeeping shared by the empty-feed branch and the summary-only
 * crawl novelty gate. Writes a `no_change` fetch_log row and advances the
 * source's exponential backoff (`consecutiveNoChange++`,
 * `nextFetchAfter = now + min(2^(n-1), 48)h`), resets the error counter, and
 * clears `changeDetectedAt`. `releasesFound` is what the feed surfaced this
 * poll — 0 for an empty feed, the item count when items were present but none
 * were new — so the fetch_log row stays honest about what we saw.
 */
async function recordNoChange(
  db: D1Db,
  source: Source,
  opts: { sessionId: string | null; start: number; releasesFound: number },
): Promise<FetchOneResult> {
  const newNoChange = (source.consecutiveNoChange ?? 0) + 1;
  const backoffHours = Math.min(Math.pow(2, newNoChange - 1), 48);
  const nextFetch = new Date(Date.now() + backoffHours * 3600_000).toISOString();
  // db.batch is atomic — the fetch_log row and the backoff stamp commit
  // together or neither does. A half-written state (log row without the
  // matching counter advance, or vice versa) would either drop the source from
  // observability or relax the cadence with no record of why. Mirrors
  // delegateScrapeToUpdateWorkflow's handoff write.
  const ops = [
    db.insert(fetchLog).values({
      sourceId: source.id,
      sessionId: opts.sessionId,
      releasesFound: opts.releasesFound,
      releasesInserted: 0,
      durationMs: Date.now() - opts.start,
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
  ];
  await db.batch(ops as [(typeof ops)[number], ...typeof ops]);
  return {
    releasesFound: opts.releasesFound,
    releasesInserted: 0,
    durationMs: Date.now() - opts.start,
    status: "no_change" as const,
  };
}

/**
 * Per-fire cap on marketing-classifier calls, applied to the genuinely-new
 * items in a fire (not the re-listed feed window). A normal feed delta is 0–5
 * items; a first-onboard backfill can be 50+. Above the cap we skip
 * classification and insert visibly — operators can run a one-off backfill via
 * the suppress API.
 */
const MARKETING_CLASSIFIER_MAX_PER_FIRE = 20;

/**
 * Indices of `rawReleases` whose URL is not already stored for this source —
 * i.e. the items a subsequent insert would actually persist (the rest collide
 * on `UNIQUE(source_id, url)` and are dropped by `onConflictDoNothing`). Feeds
 * re-list their whole window every fetch (dbt-blog returns 25, ClickHouse 200),
 * so classifying — and capping — against `rawReleases.length` would trip the
 * cap on every fire and permanently disable the filter for high-volume feeds.
 *
 * Items with no URL count as new: the insert path always writes them (SQLite
 * treats NULL as distinct under the unique index), so they should be classified
 * too. Lookups are chunked under D1's 100-bind cap.
 */
async function selectNewReleaseIndices(
  db: D1Db,
  sourceId: string,
  rawReleases: readonly RawRelease[],
): Promise<number[]> {
  const candidateUrls = [
    ...new Set(
      rawReleases
        .map((raw) => raw.url)
        .filter((url): url is string => typeof url === "string" && url.length > 0),
    ),
  ];

  const existing = new Set<string>();
  for (let i = 0; i < candidateUrls.length; i += RELEASES_ID_IN_CHUNK_SIZE) {
    const slice = candidateUrls.slice(i, i + RELEASES_ID_IN_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- chunked IN lookup; stays under D1's 100-bind cap
    const rows = await db
      .select({ url: releases.url })
      .from(releases)
      .where(and(eq(releases.sourceId, sourceId), inArray(releases.url, slice)));
    for (const row of rows) if (row.url) existing.add(row.url);
  }

  const indices: number[] = [];
  for (const [index, raw] of rawReleases.entries()) {
    if (raw.url && existing.has(raw.url)) continue;
    indices.push(index);
  }
  return indices;
}

/**
 * Per-source marketing classification. Runs Haiku 4.5 sequentially over each
 * raw release; returns a map keyed by raw-release array index (collision-free
 * across title-only feed items) containing only entries classified as
 * marketing. Callers flip `suppressed=true` + `suppressedReason` on those rows
 * before insert so they never enter the publish / embed paths.
 *
 * Fail-open: every error path (missing API key, classifier throw, cap tripped,
 * client-construction throw) returns an empty map after logging, never lets an
 * exception escape. False negatives are recoverable (operators can suppress
 * post-hoc); false positives create user-visible churn. Sequential per-item
 * (vs. parallel) is a cost/concurrency-budget choice; the prompt cache hit is
 * isolate-wide, so it doesn't depend on call ordering.
 */
async function classifyMarketingForReleases(
  db: D1Db,
  source: Source,
  meta: SourceMetadata,
  rawReleases: readonly RawRelease[],
  env: FetchOneEnv,
): Promise<Map<number, MarketingClassifierResult>> {
  const result = new Map<number, MarketingClassifierResult>();
  if (rawReleases.length === 0) return result;

  // Only the items an insert would actually persist are worth classifying;
  // the rest are re-listed feed entries we already have. Counting the whole
  // window against the cap is what let marketing slip through on high-volume
  // feeds (see selectNewReleaseIndices).
  const newIndices = await selectNewReleaseIndices(db, source.id, rawReleases);
  if (newIndices.length === 0) return result;

  if (newIndices.length > MARKETING_CLASSIFIER_MAX_PER_FIRE) {
    logEvent("warn", {
      component: "cron-poll-fetch",
      event: "marketing-filter-cap-tripped",
      sourceSlug: source.slug,
      candidateCount: newIndices.length,
      cap: MARKETING_CLASSIFIER_MAX_PER_FIRE,
    });
    return result;
  }

  let suppressedCount = 0;
  let failedCount = 0;
  let inputTokens = 0;
  let cacheCreateTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  const startedAt = Date.now();

  // Provider/model decided here (Anthropic Haiku via gateway, or a cheap
  // OpenRouter model when `openrouter-enabled` is on + a model is configured).
  // Fail-open: null means no usable provider — skip rather than block insert.
  const model = await resolveMarketingModel(env);
  if (!model) {
    logEvent("warn", {
      component: "cron-poll-fetch",
      event: "marketing-filter-no-api-key",
      sourceSlug: source.slug,
    });
    return result;
  }

  try {
    for (const index of newIndices) {
      const raw = rawReleases[index];
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential per-item bounds concurrent inference load per cron fire; the prompt cache hit doesn't depend on ordering
        const verdict = await classifyMarketing(model, {
          sourceName: source.name,
          title: raw.title,
          content: raw.content,
          url: raw.url ?? null,
          hint: meta.marketingFilterHint ?? null,
        });
        inputTokens += verdict.usage.input;
        cacheCreateTokens += verdict.usage.cacheCreate;
        cacheReadTokens += verdict.usage.cacheRead;
        outputTokens += verdict.usage.output;
        costUsd += verdict.usage.costUsd ?? 0;
        if (verdict.isMarketing) {
          result.set(index, verdict);
          suppressedCount++;
        }
      } catch (err) {
        failedCount++;
        logEvent("warn", {
          component: "cron-poll-fetch",
          event: "marketing-filter-classify-failed",
          sourceSlug: source.slug,
          itemUrl: raw.url ?? null,
          err,
        });
      }
    }
  } catch (err) {
    // Per-item errors are caught above; reaching here means the classify loop
    // threw outside an item (unexpected) — log and return what we have.
    logEvent("warn", {
      component: "cron-poll-fetch",
      event: "marketing-filter-bootstrap-failed",
      sourceSlug: source.slug,
      err,
    });
    return result;
  }

  logEvent("info", {
    component: "cron-poll-fetch",
    event: "marketing-filter-applied",
    sourceSlug: source.slug,
    modelId: model.id,
    classified: newIndices.length,
    suppressed: suppressedCount,
    failed: failedCount,
    inputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    outputTokens,
    costUsd,
    durationMs: Date.now() - startedAt,
  });

  return result;
}

export interface IngestResult {
  insertedIds: string[];
  found: number;
  inserted: number;
  visiblePublishRows: InsertedReleaseRow[];
}

export async function ingestRawReleases(
  db: D1Db,
  source: Source,
  rawReleases: RawRelease[],
  env: FetchOneEnv,
  // The cron `fetchOne` may have mutated its in-memory `meta` earlier in the
  // same fire (e.g. `meta.feedContentDepth = "summary-only"` so this batch
  // enriches with no one-fire delay). Accept that object so the mutation is
  // visible to `buildEnrichMap` below; callers with no prior mutation (the
  // Firecrawl ingest workflow) omit it and get a fresh parse.
  meta: ReturnType<typeof getSourceMeta> = getSourceMeta(source),
): Promise<IngestResult> {
  // Defense-in-depth `feedUrlDeny` (#1335). The cron `fetchOne` already filters
  // denied URLs in-memory before calling here, but the Firecrawl ingest and
  // backfill workflows call `ingestRawReleases` directly with an unfiltered
  // list — applying the denylist at this shared in-process write boundary means
  // every non-HTTP ingest path drops locale-suffixed translation dupes (the
  // HTTP `/releases/batch` path carries its own guard). Run it before the
  // marketing/enrich passes so denied items never incur inference cost; on the
  // cron path the upstream filter makes this a cheap no-op.
  if (meta.feedUrlDeny && meta.feedUrlDeny.length > 0) {
    const filtered = filterByUrlDeny(rawReleases, meta.feedUrlDeny);
    if (filtered.dropped > 0) {
      logEvent("info", {
        component: "cron-poll-fetch",
        event: "url-deny-filter-applied",
        sourceSlug: source.slug,
        kept: filtered.kept.length,
        dropped: filtered.dropped,
        feedUrlDeny: meta.feedUrlDeny,
      });
    }
    rawReleases = filtered.kept;
  }

  // Title-dedup for scrape sources (#1410): collapse same-source same-normalized-
  // title entries that synthesized anchor URLs (`<page>#<slug>`) fail to dedup —
  // notably a local backfill's heading-slug anchor (`#may-2026`) vs the cron's
  // slug(title) anchor for the SAME release. Scrape-scoped (feed/github/appstore
  // carry stable real URLs); kill-switchable; run before the marketing/enrich
  // passes so dropped dupes never incur inference cost.
  if (source.type === "scrape" && rawReleases.length > 0) {
    const dedupDisabled = await flag(
      env.FLAGS,
      env.SCRAPE_TITLE_DEDUP_DISABLED,
      FLAGS.scrapeTitleDedupDisabled,
    );
    if (!dedupDisabled) {
      const existing = await selectExistingReleaseKeys(db, source.id);
      const deduped = dedupeByExistingTitle(rawReleases, existing.titleKeys, existing.urls);
      if (deduped.dropped > 0) {
        logEvent("info", {
          component: "cron-poll-fetch",
          event: "title-dedup-applied",
          sourceSlug: source.slug,
          kept: deduped.kept.length,
          dropped: deduped.dropped,
        });
      }
      rawReleases = deduped.kept;
    }
  }

  const marketingMap =
    meta.marketingFilter === true
      ? await classifyMarketingForReleases(db, source, meta, rawReleases, env)
      : new Map<number, MarketingClassifierResult>();

  const enrichMap = await buildEnrichMap(db, source, meta, rawReleases, env);

  // Media pre-pass. Always unwrap Next.js/Vercel optimizer proxy URLs so
  // downstream readers see the underlying CDN asset. When the `MEDIA` bucket
  // is bound (#1177), additionally drop junk (favicons / avatars / pixels) and
  // mirror survivors into `released-media` so reads resolve a same-origin
  // `r2Url`. Sequential per release (the helper bounds image concurrency
  // within); fail-open — any image-level failure keeps the third-party URL. An
  // unbound `MEDIA` bucket = today's verbatim behavior.
  const r2UploadEnabled = env.MEDIA != null;
  // GIF→MP4 transcode (#1368): store ingested GIFs as small MP4s. Gated on its own
  // flag AND the transform binding being bound; off → GIFs mirror verbatim.
  const transcodeGif =
    env.MEDIA_TRANSFORM != null &&
    (await flag(env.FLAGS, env.MEDIA_GIF_TRANSCODE_ENABLED, FLAGS.mediaGifTranscodeEnabled));
  // Mirror media only for releases the insert below will actually create —
  // existing URLs are skipped by onConflictDoNothing, so their media JSON is
  // discarded and re-fetching their images every fire would be pure waste.
  // Only queried when R2 upload is on; the normalize pass always runs.
  const existingMediaUrls = r2UploadEnabled
    ? await selectExistingReleaseUrls(
        db,
        source.id,
        rawReleases.map((r) => r.url),
      )
    : new Set<string>();
  const mediaJsonByIndex: string[] = [];
  for (let index = 0; index < rawReleases.length; index++) {
    const raw = rawReleases[index]!;
    const enrich = enrichMap.get(index);
    // Keep feed-provided media; backfill from the enriched article only when
    // the feed item carried none (spec: article media only when feed is empty).
    const rawMedia =
      raw.media && raw.media.length > 0 ? raw.media : (enrich?.media ?? raw.media ?? []);
    // oxlint-disable-next-line no-map-spread -- copy-on-write required; m is an adapter-returned object
    const base = rawMedia.map((m) => ({ ...m, url: normalizeMediaUrl(m.url) }));
    const isNewRelease = raw.url == null || !existingMediaUrls.has(raw.url);
    // Promote hosted-video links found inline in the body (Wistia/Loom/Vimeo/
    // YouTube) into a `type: "video"` media item carrying the oEmbed poster
    // (`url`, mirrored to R2 like any image) + watch URL (`linkUrl`) so the web
    // renders a play-thumbnail card instead of a bare link (#1549). Fail-open:
    // an unresolvable embed yields nothing and the bare link stays. Only for
    // new releases — re-detecting on every fire would re-fetch oEmbed for rows
    // we won't re-insert. The release body is the only inline-asset source we
    // promote (deliberately narrow vs. mirroring all inline images).
    const inlineVideos = isNewRelease
      ? // oxlint-disable-next-line no-await-in-loop -- sequential per release; helper bounds oEmbed concurrency internally
        await detectInlineVideos(enrich?.content ?? raw.content)
      : [];
    const withVideos = inlineVideos.length > 0 ? [...base, ...inlineVideos] : base;
    let finalMedia = withVideos;
    if (r2UploadEnabled && isNewRelease && withVideos.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- sequential per release; helper bounds image concurrency internally
      finalMedia = await processMediaForR2(filterJunkMedia(withVideos), {
        db,
        bucket: env.MEDIA!,
        sourceId: source.id,
        mediaTransform: env.MEDIA_TRANSFORM,
        transcodeGif,
      });
    }
    mediaJsonByIndex[index] = JSON.stringify(finalMedia);
  }

  // Denormalized category for category-feed index seeks (#886).
  const effectiveCategory =
    (await fetchEffectiveCategoryBySourceIds(db, [source.id])).get(source.id) ?? null;

  const rows = rawReleases.map((raw, index) => {
    const enrich = enrichMap.get(index);
    const content = enrich?.content ?? raw.content;
    const size = computeContentSize(content);
    const verdict = marketingMap.get(index);
    return {
      sourceId: source.id,
      version: raw.version ?? null,
      versionSort: computeVersionSort(raw.version),
      title: raw.title,
      content,
      url: raw.url ?? null,
      // Honor an adapter-provided release type (e.g. the Zendesk adapter classes
      // periodic digests as `rollup`); existing feed/github/appstore adapters
      // leave it unset, so this is a no-op for them (column default `feature`).
      type: raw.type ?? "feature",
      contentHash: contentHash({ ...raw, content }),
      contentChars: size.contentChars,
      contentTokens: size.contentTokens,
      publishedAt: raw.publishedAt?.toISOString() ?? null,
      prerelease: raw.prerelease ?? isPrereleaseVersion(raw.version),
      media: mediaJsonByIndex[index]!,
      effectiveCategory,
      ...(enrich ? { metadata: JSON.stringify({ enrichment: enrich.marker }) } : {}),
      suppressed: verdict?.isMarketing === true,
      suppressedReason: verdict?.isMarketing ? `marketing_classifier:${verdict.reason}` : null,
    };
  });

  let inserted = 0;
  const publishRows: InsertedReleaseRow[] = [];
  const clusterRows: Array<{ id: string; version: string | null; content: string }> = [];
  const suppressedIds = new Set<string>();
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
      type: releases.type,
      suppressed: releases.suppressed,
    });
    inserted += result.length;
    for (const r of result) {
      const { content, suppressed, ...publishRow } = r;
      if (suppressed === true) suppressedIds.add(r.id);
      publishRows.push(publishRow);
      clusterRows.push({ id: r.id, version: r.version, content });
    }
  }
  const insertedIds = publishRows.map((r) => r.id).filter((id) => !suppressedIds.has(id));

  // Detect changesets cascade rows and demote them to coverage so they
  // stay out of the default feed, the live tail, and per-source IndexNow
  // counts. Synchronous: coverage state must be visible to the publish
  // path below.
  const cascadeResult = await clusterAndPersistCascades(db, clusterRows, {
    component: "poll-fetch",
    sourceId: source.id,
  });
  const visiblePublishRows =
    cascadeResult.coverageIds.size > 0 || suppressedIds.size > 0
      ? publishRows.filter((r) => !cascadeResult.coverageIds.has(r.id) && !suppressedIds.has(r.id))
      : publishRows;

  if (visiblePublishRows.length > 0 && env.RELEASE_HUB) {
    await publishReleaseEvents(
      {
        RELEASE_HUB: env.RELEASE_HUB,
        WEBHOOK_DELIVERY_QUEUE: env.WEBHOOK_DELIVERY_QUEUE,
        DB: env.DB,
      },
      {
        src: {
          name: source.name,
          slug: source.slug,
          orgId: source.orgId,
          sourceId: source.id,
          type: source.type,
          productId: source.productId,
        },
        inserted: visiblePublishRows,
      },
    );
  }

  // Fire-and-forget IndexNow ping for the org/source/product surfaces whose
  // lastmod just shifted. No-ops when INDEXING_DISABLED (staging) or the
  // INDEXNOW_KEY binding is absent (dev). Per-release URLs are intentionally
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

  return { insertedIds, found: rawReleases.length, inserted, visiblePublishRows };
}

export async function fetchOne(
  db: D1Db,
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
    /**
     * Skip the `delegateScrapeToUpdateWorkflow` branch even when the source would
     * normally qualify for crawl delegation. Set by the `POST /v1/sources/:id/fetch`
     * route when the caller is a managed-agent session (detected via the
     * `X-Releases-MA-Session` request header). Without this guard the session
     * would re-enter its own session-start path and self-collide on the
     * per-source KV lock from #1058. See #1061.
     */
    skipDelegation?: boolean;
    /**
     * Pre-built Web Bot Auth signing fetch shared across a cron fire. When
     * omitted, fetchOne builds its own via makeBotFetch(env); passing the
     * instance hoisted in `pollAndFetch` avoids one Secrets Store read per
     * source when signing is enabled.
     */
    signedFetch?: typeof fetch;
  },
): Promise<FetchOneResult> {
  const start = Date.now();
  const meta = getSourceMeta(source);
  const sessionId = opts?.sessionId ?? null;
  const dryRun = opts?.dryRun ?? false;
  const maxEntries = opts?.maxEntries ?? DEFAULT_FETCH_MAX_ENTRIES;
  const skipSideEffects = opts?.skipSideEffects ?? false;
  const skipDelegation = opts?.skipDelegation ?? false;

  try {
    let rawReleases: RawRelease[];
    let repoStars: number | null = null;

    if (isGitHubFetched(source, meta)) {
      const repoUrl = effectiveGitHubUrl(source, meta);
      const [releases, stars] = await Promise.all([
        fetchGitHub(source, env.GITHUB_TOKEN, { repoUrl }),
        fetchRepoStars(repoUrl, env.GITHUB_TOKEN),
      ]);
      rawReleases = releases;
      repoStars = stars;
    } else if (isAppStoreFetched(source)) {
      const coord = appStoreCoordFromSource(source);
      const listing = coord ? await resolveAppStore(coord) : null;
      rawReleases = listing ? mapListingToRawReleases(listing, coord!) : [];
      if (!dryRun && listing) {
        await refreshAppStoreListing(db, source, listing);
      }
    } else if (isVideoFetched(source)) {
      if (!meta.feedUrl || !meta.video?.provider) {
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
            error: "Missing feedUrl or video.provider in source metadata",
          })
          .catch(
            logSwallowed("cron-poll-fetch", "fetch-log-write-failed", { sourceSlug: source.slug }),
          );
        return {
          releasesFound: 0,
          releasesInserted: 0,
          durationMs: dur,
          status: "error",
          error: "Missing feedUrl or video.provider in source metadata",
        };
      }
      const conditionalHeaders: Record<string, string> = {};
      if (meta.feedEtag) conditionalHeaders["If-None-Match"] = meta.feedEtag;
      if (meta.feedLastModified) conditionalHeaders["If-Modified-Since"] = meta.feedLastModified;

      const provider = resolveVideoProvider(meta.video.provider);
      const botFetch = opts?.signedFetch ?? (await makeBotFetch(env));
      const result = await fetchAndParseVideoFeed(
        meta.feedUrl,
        provider,
        Object.keys(conditionalHeaders).length > 0 ? conditionalHeaders : undefined,
        botFetch,
      );
      rawReleases = result.releases.slice(0, maxEntries);

      if (!dryRun) {
        const metaUpdates: Partial<SourceMetadata> = {};
        if (result.etag) metaUpdates.feedEtag = result.etag;
        if (result.lastModified) metaUpdates.feedLastModified = result.lastModified;
        if (Object.keys(metaUpdates).length > 0) {
          const merged = { ...meta, ...metaUpdates };
          await db
            .update(sources)
            .set({ metadata: JSON.stringify(merged) })
            .where(eq(sources.id, source.id));
        }
      }
    } else if (meta.helpCenter?.provider) {
      // Help-center API source (type:feed whose feedUrl is a vendor JSON API,
      // not RSS/Atom — e.g. Zendesk). Route to the deterministic parser instead
      // of fetchAndParseFeed. Newest-first single page is enough for steady state:
      // new articles land on page 1 and the UNIQUE(source_id, url) upsert dedups
      // the overlap; deeper history is a one-time local backfill.
      rawReleases = await fetchHelpCenter(source, { maxEntries });
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
          .catch(
            logSwallowed("cron-poll-fetch", "fetch-log-write-failed", { sourceSlug: source.slug }),
          );
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

      const botFetch = opts?.signedFetch ?? (await makeBotFetch(env));
      const result = await fetchAndParseFeed(
        meta.feedUrl,
        meta.feedType as "rss" | "atom" | "jsonfeed",
        { maxEntries },
        Object.keys(conditionalHeaders).length > 0 ? conditionalHeaders : undefined,
        botFetch,
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

      if (meta.feedKeywordAllow && meta.feedKeywordAllow.length > 0) {
        const filtered = filterByKeywordAllow(rawReleases, meta.feedKeywordAllow);
        if (filtered.dropped > 0) {
          logEvent("info", {
            component: "cron-poll-fetch",
            event: "keyword-filter-applied",
            sourceSlug: source.slug,
            kept: filtered.kept.length,
            dropped: filtered.dropped,
            feedKeywordAllow: meta.feedKeywordAllow,
          });
        }
        rawReleases = filtered.kept;
      }

      if (meta.feedUrlDeny && meta.feedUrlDeny.length > 0) {
        const filtered = filterByUrlDeny(rawReleases, meta.feedUrlDeny);
        if (filtered.dropped > 0) {
          logEvent("info", {
            component: "cron-poll-fetch",
            event: "url-deny-filter-applied",
            sourceSlug: source.slug,
            kept: filtered.kept.length,
            dropped: filtered.dropped,
            feedUrlDeny: meta.feedUrlDeny,
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
        // Auto-detect summary-only feeds once and persist the flag. Only set it;
        // never clear it here (a feed that upgrades to full bodies clearing the
        // flag is future work). Skip if already decided.
        if (!meta.feedContentDepth) {
          const thinChars = parsePositiveInt(env.FEED_THIN_CHARS, DEFAULT_FEED_THIN_CHARS);
          const depth = assessFeedDepth(rawReleases, { thinChars });
          if (depth === "summary-only" || depth === "anchor-fragment") {
            metaUpdates.feedContentDepth = depth;
            // Reflect the just-detected value in the in-memory meta so this same
            // run's buildEnrichMap enriches the batch (no one-fire delay). Only
            // set it here; clearing stays future work per the comment above.
            meta.feedContentDepth = depth;
            logEvent("info", {
              component: "cron-poll-fetch",
              event: "feed-depth-detected",
              sourceSlug: source.slug,
              depth,
              feedItemCount: rawReleases.length,
            });
          }
        }
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
      const result = await recordNoChange(db, source, { sessionId, start, releasesFound: 0 });
      logEvent("info", {
        component: "cron-poll-fetch",
        event: "fetch-no-changes",
        sourceSlug: source.slug,
        durationMs: result.durationMs,
      });
      return result;
    }

    // Summary-only feed (e.g. RSS that only carries `<title>` + `<link>`):
    // inserting the parsed rows would persist empty-body releases under the
    // feed's link URLs. When `crawlEnabled: true` is set, delegate to the
    // deterministic update workflow's crawl + extract pipeline instead so the
    // per-release pages get fetched and bodies + media land in D1. The feed
    // becomes a pure change detector. Dry-runs skip this branch — they're
    // supposed to be cheap probes of the feed itself, not full crawls.
    if (
      !dryRun &&
      !skipDelegation &&
      env.DETERMINISTIC_UPDATE_WORKFLOW &&
      shouldDelegateToCrawl(source, meta, rawReleases)
    ) {
      // The summary-only feed is the change detector: only pay for a managed-
      // agent crawl when it surfaces a release URL we don't already have.
      // Otherwise a quiet source (Notion sat unchanged for ~9 days) spawns a
      // Haiku crawl on every 4h poll that crawls all N pages and inserts 0 —
      // the feed still lists items, but they're all already indexed. Gate the
      // handoff on novelty and fold the "nothing new" case into the standard
      // no-change backoff so the source's poll cadence actually relaxes.
      const existingUrls = await selectExistingReleaseUrls(
        db,
        source.id,
        rawReleases.map((r) => r.url),
      );
      const hasNewUrl = rawReleases.some(
        (r) => typeof r.url === "string" && r.url !== "" && !existingUrls.has(r.url),
      );
      if (!hasNewUrl) {
        const result = await recordNoChange(db, source, {
          sessionId,
          start,
          releasesFound: rawReleases.length,
        });
        logEvent("info", {
          component: "cron-poll-fetch",
          event: "crawl-delegation-skipped-no-new",
          sourceSlug: source.slug,
          feedItemCount: rawReleases.length,
          durationMs: result.durationMs,
        });
        return result;
      }
      logEvent("info", {
        component: "cron-poll-fetch",
        event: "crawl-delegation-start",
        sourceSlug: source.slug,
        reason:
          meta.feedContentDepth === "summary-only" ? "summary-only" : "all-items-empty-content",
        feedItemCount: rawReleases.length,
      });

      // #1814: the per-source mutex lives in the SourceActor DO and is
      // enforced by the dispatch gate (checked/acquired inside
      // startDeterministicUpdate before the workflow instance is created). No
      // extra gate is needed here — a single source's concurrent delegations
      // are serialized there.
      return await delegateScrapeToUpdateWorkflow(db, source, env);
    }

    const { insertedIds, inserted } = await ingestRawReleases(db, source, rawReleases, env, meta);

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
          // GitHub stargazer refresh — captured in parallel with the releases
          // fetch above; folded into this atomic update so it runs on both the
          // inline-cron and Workflow ingest paths. Spreads nothing when the
          // best-effort star fetch returned null.
          ...(repoStars != null && {
            stargazersCount: repoStars,
            starsFetchedAt: new Date().toISOString(),
          }),
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
      .catch(
        logSwallowed("cron-poll-fetch", "fetch-log-write-failed", { sourceSlug: source.slug }),
      );

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

    // 429/408 on the feed: transient rate-limit/timeout, NOT a gone URL. Back
    // off exponentially (at least as long as Retry-After when the server sends
    // it) via the generic consecutiveErrors ladder, and DON'T touch
    // feed4xxStreak — a rate-limited feed must never march toward feedUrl
    // invalidation. Flag the result `rateLimited` so the workflow treats it as
    // expected: no retry storm, no failure-alert email.
    if (err instanceof FeedHttpError && isTransientFeedHttpStatus(err.status)) {
      const newErrors = (source.consecutiveErrors ?? 0) + 1;
      const backoffMs = Math.min(Math.pow(2, newErrors - 1), 72) * 3600_000;
      const waitMs = Math.max(backoffMs, err.retryAfterMs ?? 0);
      const nextFetch = new Date(Date.now() + waitMs).toISOString();
      await db
        .update(sources)
        .set({ consecutiveErrors: newErrors, nextFetchAfter: nextFetch })
        .where(eq(sources.id, source.id))
        .catch(
          logSwallowed("cron-poll-fetch", "backoff-write-failed", { sourceSlug: source.slug }),
        );
      logEvent("warn", {
        component: "cron-poll-fetch",
        event: "feed-rate-limited",
        sourceSlug: source.slug,
        httpStatus: err.status,
        retryAfterMs: err.retryAfterMs,
        nextFetchAfter: nextFetch,
      });
      return {
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: Date.now() - start,
        status: "error" as const,
        error: err.message,
        rateLimited: true,
      };
    }

    // Other 4xx on the stored feedUrl (404/410/403…): track it via feed4xxStreak
    // rather than the generic consecutiveErrors backoff. Backoff would push the
    // next retry out by hours and slow self-healing — we'd rather keep the
    // normal cron cadence until the streak hits the invalidation threshold.
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
          .catch(
            logSwallowed("cron-poll-fetch", "source-metadata-write-failed", {
              sourceSlug: source.slug,
            }),
          );
      } else {
        const merged = { ...meta, feed4xxStreak: streak };
        await db
          .update(sources)
          .set({ metadata: JSON.stringify(merged) })
          .where(eq(sources.id, source.id))
          .catch(
            logSwallowed("cron-poll-fetch", "source-metadata-write-failed", {
              sourceSlug: source.slug,
            }),
          );
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
      .catch(logSwallowed("cron-poll-fetch", "backoff-write-failed", { sourceSlug: source.slug }));

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
  db: D1Db,
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
      media: rel.body ? extractMediaFromMarkdown(rel.body) : undefined,
    };
  });
}

/**
 * Best-effort GitHub stargazer count for a repo URL. One extra `/repos`
 * call per github poll (the releases fetch hits a different endpoint).
 * Returns null on ANY failure — a star count must never fail a release fetch.
 */
async function fetchRepoStars(repoUrl: string, token?: string): Promise<number | null> {
  const parsed = parseOwnerRepo(repoUrl);
  if (!parsed) return null;
  const { apiHeaders } = buildGitHubHeaders(token, RELEASES_BOT_UA);
  try {
    const res = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      headers: apiHeaders,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  }
}

// ── Embedding side effects ──
//
// These helpers hydrate DB rows, build the embed config from Worker secrets,
// push vectors to Vectorize, and mark the rows as embedded. All failures are
// swallowed by the shared helpers in @releases/search/embed-* so the callers never
// need to try/catch.

export async function embedReleasesForSource(
  db: D1Db,
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
function buildChunkOffsetUpdateStatements(db: D1Db, unchanged: ReadonlyArray<ChunkOffsetUpdate>) {
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
  db: D1Db,
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
  db: D1Db,
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
  db: D1Db,
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
  db: D1Db,
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

async function buildEnrichMap(
  db: D1Db,
  source: Source,
  meta: SourceMetadata,
  rawReleases: readonly RawRelease[],
  env: FetchOneEnv,
): Promise<Map<number, EnrichOutcome>> {
  if (
    !(await flag(env.FLAGS, env.FEED_ENRICH_ENABLED, FLAGS.feedEnrichEnabled)) ||
    meta.feedContentDepth !== "summary-only"
  ) {
    return new Map();
  }
  const thinChars = parsePositiveInt(env.FEED_THIN_CHARS, DEFAULT_FEED_THIN_CHARS);
  const deps = await buildEnrichDeps(env, thinChars, db);
  if (!deps) return new Map();

  return enrichNewThinItems(db, source, meta, rawReleases, env, {
    enrichFn: (item) => enrichFeedItem(item, deps),
  });
}
