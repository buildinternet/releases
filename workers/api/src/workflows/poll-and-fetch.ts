/**
 * Workflow-based replacement for the 2-hourly `pollAndFetch` cron. The
 * cron handler fans out one instance per due source; each instance walks
 * the ingest pipeline with a `step.do` boundary around each phase so a
 * transient failure (especially mid-embed Voyage 429s) no longer silently
 * drops vectors. See issue #486.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, sql } from "drizzle-orm";
import { organizations, products, releases, sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import type { ReleaseComposition } from "@buildinternet/releases-core/composition";
import { buildCompositionMetadataSet } from "@releases/core-internal/composition-metadata";
import { summarizeNotOptedOut } from "@releases/core-internal/eligibility";
import { releaseCoverage } from "@releases/db/schema-coverage.js";
import { SOURCE_DELETED_SENTINEL, recordWorkflowFailure } from "./_shared.js";
import { logEvent } from "@releases/lib/log-event";
import { dbErrorLogFields } from "@releases/lib/db-errors";
import { getSecret } from "@releases/lib/secrets";
import { summarizeRelease } from "@releases/ai-internal/release-content";
import {
  fetchOne,
  pollOne,
  embedReleasesForSource,
  embedChangelogFileForSource,
  refreshChangelogFile,
  loadPlaybookNotesForSources,
  type FetchOneEnv,
} from "../cron/poll-fetch.js";
import { getSourceMeta, isGitHubFetched } from "@releases/adapters/feed.js";
import { invalidateLatestCache, type InvalidationEnv } from "../lib/latest-cache.js";
import { getAnthropicKey, resolveGatewayOpts, type AnthropicEnv } from "../lib/anthropic.js";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { IN_ARRAY_CHUNK_SIZE } from "../lib/d1-limits.js";
import { makeBotFetch } from "../lib/web-bot-auth-fetch.js";
import { FLAGS, flag } from "@releases/lib/flags";

/**
 * Environment for the workflow. Bindings follow the same shape as the API
 * worker Env — secrets stay as SecretBinding here and are resolved inside
 * the step closures that consume them so they never land in instance state.
 */
export type PollAndFetchWorkflowEnv = InvalidationEnv &
  AnthropicEnv & {
    DB: D1Database;
    CRON_ENABLED?: string;
    SCRAPE_CHANGE_DETECT_ENABLED?: string;
    GITHUB_TOKEN?: { get(): Promise<string> };
    RELEASES_INDEX?: unknown;
    CHANGELOG_CHUNKS_INDEX?: unknown;
    EMBEDDING_PROVIDER?: string;
    VOYAGE_API_KEY?: { get(): Promise<string> };
    OPENAI_API_KEY?: { get(): Promise<string> };
    RELEASE_HUB?: DurableObjectNamespace;
    WEBHOOK_DELIVERY_QUEUE?: Queue<unknown>;
    /**
     * Runtime kill switch / tuning knob for the per-source jitter smear.
     * Parsed as an integer, clamped to [0, FANOUT_JITTER_WINDOW_MAX_MS]. Set
     * to "0" to disable the smear entirely; absent/invalid falls back to the
     * module-level FANOUT_JITTER_WINDOW_MS default.
     */
    FANOUT_JITTER_WINDOW_MS?: string;
    /** Service binding used to delegate summary-only feeds to discovery's crawl path (RPC). */
    DISCOVERY_WORKER?: import("../cron/poll-fetch.js").DiscoveryWorkerRpc;
    WEB_BOT_AUTH_ENABLED?: string;
    WEB_BOT_AUTH_PRIVATE_KEY?: { get(): Promise<string> };
    /** Ingest-time R2 media upload (#1177): kill switch + `released-media` bucket. */
    MEDIA_R2_UPLOAD_ENABLED?: string;
    MEDIA?: R2Bucket;
    /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
    _drizzleOverride?: unknown;
  };

export type PollAndFetchParams = {
  /** Source row id to process. */
  sourceId: string;
  /** Scheduled event time, carried through for cross-referencing against logs. */
  scheduledTime: number;
};

/**
 * Retry policies. Embed is the critical failure mode we're solving — give it
 * plenty of room to ride out Voyage rate limits. Fetch retries cover transient
 * 5xx / network blips; permanent 4xx surfaces as NonRetryableError downstream.
 */
// Exported so sibling workflows (e.g. FirecrawlIngestWorkflow) reuse the same
// retry policies instead of re-declaring identical constants.
export const RETRY_POLL = {
  retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

export const RETRY_FETCH = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} satisfies WorkflowStepConfig;

export const RETRY_EMBED = {
  retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} satisfies WorkflowStepConfig;

// Per-row failures are caught + logged inside the step body, so retries are
// conservative; the `title_generated IS NULL` predicate on the UPDATE
// makes a step-level retry safe.
export const RETRY_GENERATE = {
  retries: { limit: 1, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} satisfies WorkflowStepConfig;

/**
 * Smearing window for the per-source jitter sleep at the workflow head. The
 * cron fans out 30-160 instances per fire and every D1 overload in the last 7d
 * landed within the first 7 minutes of the hour — pure thundering-herd. We
 * spread the start of each instance across this window so the first wave of
 * `load-source` SELECTs (and the much heavier insert/update batches that
 * follow) staggers across ~5 minutes instead of seconds.
 *
 * Sleep is hash-keyed on `sourceId` so each source lands in a deterministic
 * slot — replays of the same instance always pick the same delay, and the
 * distribution is stable across fires (any given source's load is predictable
 * over the day, not randomized into adjacent peaks).
 */
const FANOUT_JITTER_WINDOW_MS = 300_000;
const FANOUT_JITTER_WINDOW_MAX_MS = 3_600_000;

// FNV-1a, 32-bit. Cheap, deterministic, no Web Crypto dependency.
function fnv1a32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function jitterMsForSource(sourceId: string, windowMs: number): number {
  if (windowMs <= 0) return 0;
  return fnv1a32(sourceId) % windowMs;
}

/**
 * Resolve the FetchOneEnv slice — embedding + GitHub + vector bindings — once
 * and cache it across steps. Secrets are fetched lazily inside steps that
 * need them (none of them here land in the workflow's persisted state because
 * the returned object only flows through closures).
 */
export async function resolveFetchEnv(env: PollAndFetchWorkflowEnv): Promise<FetchOneEnv> {
  const githubToken = (await getSecret(env.GITHUB_TOKEN).catch(() => null)) ?? undefined;
  return {
    GITHUB_TOKEN: githubToken,
    RELEASES_INDEX: env.RELEASES_INDEX,
    CHANGELOG_CHUNKS_INDEX: env.CHANGELOG_CHUNKS_INDEX,
    EMBEDDING_PROVIDER: env.EMBEDDING_PROVIDER,
    VOYAGE_API_KEY: env.VOYAGE_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    RELEASE_HUB: env.RELEASE_HUB,
    WEBHOOK_DELIVERY_QUEUE: env.WEBHOOK_DELIVERY_QUEUE,
    DB: env.DB,
    DISCOVERY_WORKER: env.DISCOVERY_WORKER,
    WEB_BOT_AUTH_ENABLED: env.WEB_BOT_AUTH_ENABLED,
    WEB_BOT_AUTH_PRIVATE_KEY: env.WEB_BOT_AUTH_PRIVATE_KEY,
    MEDIA_R2_UPLOAD_ENABLED: env.MEDIA_R2_UPLOAD_ENABLED,
    MEDIA: env.MEDIA,
    FLAGS: env.FLAGS,
  };
}

/**
 * Per-fire row cap. A typical fire is 0–3 rows; anything larger is almost
 * always a monorepo dump or first-onboard backfill, neither of which is a
 * useful target for the per-row LLM call. Bail loudly and let a deliberate
 * `scripts/generate-release-content.ts` invocation mop up if wanted.
 */
const MAX_AUTOGEN_ROWS_PER_FIRE = 20;

/**
 * Per-row body cap (chars). Haiku 4.5 input is $1/M tokens (~4 chars/token),
 * so 50k chars ≈ 12.5k tokens ≈ $0.013 per call before output. Above that we
 * skip the row — outlier bodies don't summarize well and they dominate cost.
 */
const MAX_AUTOGEN_BODY_CHARS = 50_000;

/**
 * Per-org opt-in: when the source's org has `auto_generate_content = true`
 * and the source isn't hidden, run freshly-inserted releases through Haiku
 * 4.5 to populate `title_generated` / `title_short` / `summary`. A source can
 * opt out individually via `metadata.summarize = false` (see
 * `summarizeNotOptedOut`) — useful for App Store apps whose notes are always
 * boilerplate. The opt-out lives in the SELECT predicate so it holds for the
 * partial-source `regenerate` caller in routes/workflows.ts too.
 *
 * Per-row exceptions log + continue so a single bad call can't pin the
 * workflow into a retry storm. The step itself only throws on outer-loop
 * failures (SELECT, client construction).
 */
export async function generateContentForReleases(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern; same as the rest of this workflow
  db: any,
  env: PollAndFetchWorkflowEnv,
  source: Source,
  insertedIds: string[],
): Promise<void> {
  // Hidden sources skip AI features per existing convention.
  if (source.isHidden === true) return;

  // Order matters: SELECT before secret-store fetch. Most orgs are opted out,
  // and the empty-result path saves a Secrets Store round-trip per non-opted
  // source on every cron fire. The IN list is chunked for the D1 100-bind cap
  // (90 ids + 1 boolean = 91 binds per statement); a backfill or first-time
  // onboard can push insertedIds well past 90.
  type ContentRow = {
    id: string;
    title: string;
    version: string | null;
    content: string;
    url: string | null;
    orgSlug: string;
    sourceName: string;
    productName: string | null;
  };
  const rows: ContentRow[] = [];
  for (let i = 0; i < insertedIds.length; i += IN_ARRAY_CHUNK_SIZE) {
    const chunk = insertedIds.slice(i, i + IN_ARRAY_CHUNK_SIZE);
    // eslint-disable-next-line no-await-in-loop -- D1 chunked SELECT (100 bind param limit)
    // Skip coverage-side rows: they're hidden from read paths by default, so
    // summarizing them is a pure waste. The LEFT JOIN keeps canonical and
    // unlinked rows; the IS NULL filter drops anything that's already linked
    // as coverage to another release.
    const chunkRows: ContentRow[] = await db
      .select({
        id: releases.id,
        title: releases.title,
        version: releases.version,
        content: releases.content,
        url: releases.url,
        orgSlug: organizations.slug,
        sourceName: sources.name,
        productName: products.name,
      })
      .from(releases)
      .innerJoin(sources, eq(sources.id, releases.sourceId))
      .innerJoin(organizations, eq(organizations.id, sources.orgId))
      .leftJoin(products, eq(products.id, sources.productId))
      .leftJoin(releaseCoverage, eq(releaseCoverage.coverageId, releases.id))
      .where(
        and(
          inArray(releases.id, chunk),
          eq(organizations.autoGenerateContent, true),
          summarizeNotOptedOut(),
          sql`${releaseCoverage.coverageId} IS NULL`,
        ),
      );
    rows.push(...chunkRows);
  }

  if (rows.length === 0) return;

  if (rows.length > MAX_AUTOGEN_ROWS_PER_FIRE) {
    logEvent("warn", {
      component: "auto-generate-content",
      event: "row-cap-tripped",
      sourceSlug: source.slug,
      candidateCount: rows.length,
      cap: MAX_AUTOGEN_ROWS_PER_FIRE,
    });
    return;
  }

  const apiKey = await getAnthropicKey(env);
  if (!apiKey) return;

  const startedAt = Date.now();
  const client = buildAnthropicClient({ apiKey, ...(await resolveGatewayOpts(env)) });

  let skippedEmpty = 0;
  let skippedTooLarge = 0;
  let failed = 0;
  let totalTokens = 0;

  // Sequential LLM calls (cache warming + cost bounding depend on this), then
  // a single batched UPDATE pass at the end. Each UPDATE binds at most 5 values
  // (titleGenerated, titleShort, summary, optional compositionJson, id) →
  // chunk at 20 to stay under D1's 100-bind per-statement cap. WHERE
  // title_generated IS NULL preserves idempotency against step retry — and
  // unlike title_short, it survives the boilerplate-discard path (where
  // title_short is intentionally null) so eligibility doesn't re-pick those
  // rows on the next batch run. When composition is null we omit metadata SET
  // entirely so boilerplate
  // rows don't trigger a no-op D1 page write.
  const updates: {
    id: string;
    titleGenerated: string | null;
    titleShort: string | null;
    summary: string | null;
    composition: ReleaseComposition | null;
  }[] = [];

  for (const row of rows) {
    if ((row.content?.length ?? 0) > MAX_AUTOGEN_BODY_CHARS) {
      skippedTooLarge++;
      logEvent("warn", {
        component: "auto-generate-content",
        event: "body-cap-skip",
        releaseId: row.id,
        orgSlug: row.orgSlug,
        bodyChars: row.content.length,
        cap: MAX_AUTOGEN_BODY_CHARS,
      });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential per-row keeps cost bounded; typical fire is 0–3 rows
      const result = await summarizeRelease(client, {
        orgSlug: row.orgSlug,
        sourceName: row.sourceName,
        productName: row.productName,
        title: row.title,
        version: row.version,
        url: row.url,
        content: row.content,
      });
      totalTokens +=
        result.usage.input +
        result.usage.output +
        result.usage.cacheCreate +
        result.usage.cacheRead;
      if (result.skipped) {
        skippedEmpty++;
        continue;
      }
      updates.push({
        id: row.id,
        titleGenerated: result.title,
        titleShort: result.titleShort,
        summary: result.summary,
        composition: result.composition,
      });
    } catch (err) {
      failed++;
      logEvent("warn", {
        component: "auto-generate-content",
        event: "generation-failed",
        releaseId: row.id,
        orgSlug: row.orgSlug,
        err,
      });
    }
  }

  let generated = 0;
  const UPDATE_CHUNK_SIZE = 20; // floor(100 / 5 binds per UPDATE)
  for (let i = 0; i < updates.length; i += UPDATE_CHUNK_SIZE) {
    const chunk = updates.slice(i, i + UPDATE_CHUNK_SIZE);
    const statements = chunk.map((u) => {
      const metadataSet = buildCompositionMetadataSet(u.composition);
      return db
        .update(releases)
        .set({
          titleGenerated: u.titleGenerated,
          titleShort: u.titleShort,
          summary: u.summary,
          ...(metadataSet ? { metadata: metadataSet } : {}),
        })
        .where(and(eq(releases.id, u.id), sql`${releases.titleGenerated} IS NULL`));
    });
    try {
      // eslint-disable-next-line no-await-in-loop -- chunked batch; parallelism would exceed D1 limits
      await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
      generated += chunk.length;
    } catch (err) {
      failed += chunk.length;
      logEvent("warn", {
        component: "auto-generate-content",
        event: "update-batch-failed",
        chunkOffset: i,
        chunkSize: chunk.length,
        err,
        ...dbErrorLogFields(err),
      });
    }
  }

  logEvent("info", {
    component: "auto-generate-content",
    event: "batch-summary",
    sourceSlug: source.slug,
    candidateCount: rows.length,
    generated,
    skippedEmpty,
    skippedTooLarge,
    failed,
    totalTokens,
    durationMs: Date.now() - startedAt,
  });
}

export class PollAndFetchWorkflow extends WorkflowEntrypoint<
  PollAndFetchWorkflowEnv,
  PollAndFetchParams
> {
  async run(event: WorkflowEvent<PollAndFetchParams>, step: WorkflowStep): Promise<void> {
    const env = this.env;

    if (env.CRON_ENABLED === "false") {
      logEvent("info", { component: "poll-fetch-workflow", event: "cron-disabled" });
      return;
    }

    const { sourceId, scheduledTime } = event.payload;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = env._drizzleOverride ?? drizzle(env.DB);

    // Skipped under tests via _drizzleOverride so suites don't pay the sleep cost.
    if (!env._drizzleOverride) {
      const rawWindow = parseInt(env.FANOUT_JITTER_WINDOW_MS ?? "", 10);
      const windowMs = Number.isNaN(rawWindow)
        ? FANOUT_JITTER_WINDOW_MS
        : Math.min(Math.max(rawWindow, 0), FANOUT_JITTER_WINDOW_MAX_MS);
      const jitterMs = jitterMsForSource(sourceId, windowMs);
      if (jitterMs > 0) {
        await step.sleep("jitter-smear-fanout", jitterMs);
      }
    }

    // Track the last step name so the failure row has useful context.
    let currentStep = "load-source";

    try {
      // Load the source row. Missing → NonRetryableError (source was deleted
      // between cron fan-out and workflow start — nothing to do).
      const source = await step.do("load-source", async () => {
        const [row]: Source[] = await db.select().from(sources).where(eq(sources.id, sourceId));
        if (!row) throw new NonRetryableError(SOURCE_DELETED_SENTINEL);
        return row;
      });

      // Defense-in-depth: queryDueSources already excludes firecrawl-owned
      // sources from the fan-out, but guard here too so a manual trigger or
      // a future regression in the exclusion predicate can't cause
      // double-ingest. Firecrawl sources are ingested via the inbound webhook
      // + FirecrawlIngestWorkflow exclusively.
      if (getSourceMeta(source).firecrawl?.enabled) {
        logEvent("info", {
          component: "poll-and-fetch-workflow",
          event: "firecrawl-owned-skip",
          sourceId: source.id,
          slug: source.slug,
        });
        return;
      }

      const now = new Date();
      const changeDetectEnabled = await flag(
        env.FLAGS,
        env.SCRAPE_CHANGE_DETECT_ENABLED,
        FLAGS.scrapeChangeDetectEnabled,
      );

      // Poll phase: HEAD check (feed sources) or mark-changed (github). For
      // scrape-no-feed / agent sources the flag opens a quirks-driven detector
      // branch inside pollOne (#517). Playbook notes are loaded per instance
      // so the step doesn't pin a large payload onto workflow state.
      currentStep = "poll-head-check";
      const pollResult = await step.do("poll-head-check", RETRY_POLL, async () => {
        const notesByOrg =
          changeDetectEnabled && (source.type === "scrape" || source.type === "agent")
            ? await loadPlaybookNotesForSources(db, [source])
            : new Map<string, string | null>();
        return await pollOne(db, source, now, {
          changeDetectEnabled,
          playbookNotes: source.orgId ? (notesByOrg.get(source.orgId) ?? null) : null,
          signedFetch: await makeBotFetch(env),
        });
      });

      if (!pollResult.changed) {
        logEvent("info", {
          component: "poll-fetch-workflow",
          event: "no-change-detected",
          sourceSlug: source.slug,
        });
        return;
      }

      // Scrape-no-feed / agent sources: pollOne already wrote `changeDetectedAt`,
      // and the daily scrape-agent sweep cron drains those. Calling fetchOne here
      // would fail with "Missing feedUrl or feedType" because there's no feed to
      // hit — mirror the inline `pollAndFetch` filter. Falsy check (not `!= null`)
      // matches the gate inside fetchOne (poll-fetch.ts:446) so an empty-string
      // feedUrl can't slip past either. See #486 / #517.
      // A scrape source carrying `metadata.githubUrl` is server-side fetchable
      // via the GitHub path even without a feedUrl, so it doesn't defer (#831).
      //
      // Feed-type sources with missing feedUrl or feedType also defer — calling
      // fetchOne would log a fetch_log error row and drive backoff. They need
      // metadata repair (re-discovery), not repeated error accumulation.
      // See #1073.
      const sourceMeta = getSourceMeta(source);
      if (
        (source.type === "scrape" || source.type === "agent") &&
        !sourceMeta.feedUrl &&
        !isGitHubFetched(source, sourceMeta)
      ) {
        logEvent("info", {
          component: "poll-fetch-workflow",
          event: "defer-to-scrape-agent",
          sourceSlug: source.slug,
        });
        return;
      }

      if (source.type === "feed" && (!sourceMeta.feedUrl || !sourceMeta.feedType)) {
        logEvent("warn", {
          component: "poll-fetch-workflow",
          event: "skip-feed-broken-metadata",
          sourceSlug: source.slug,
        });
        return;
      }

      // Scrape/agent sources that have a feedUrl but are missing feedType:
      // they passed the no-feedUrl guard above (because feedUrl is truthy) but
      // fetchOne would still fail with "Missing feedUrl or feedType" and write
      // a fetch_log error row. Treat the same as the feed broken-metadata case.
      if (
        (source.type === "scrape" || source.type === "agent") &&
        sourceMeta.feedUrl &&
        !sourceMeta.feedType
      ) {
        logEvent("warn", {
          component: "poll-fetch-workflow",
          event: "skip-feed-broken-metadata",
          sourceSlug: source.slug,
        });
        return;
      }

      // Fetch + parse + insert + bookkeeping. `skipSideEffects` suppresses the
      // inline embed + CHANGELOG refresh so each runs as its own retriable
      // step below. fetchOne still handles FeedHttpError / consecutiveErrors
      // backoff internally.
      currentStep = "fetch-and-persist";
      const fetchEnv = await resolveFetchEnv(env);
      const fetchResult = await step.do("fetch-and-persist", RETRY_FETCH, async () => {
        const result = await fetchOne(db, source, fetchEnv, { skipSideEffects: true });
        // Surface fetch errors so the step retries. The inline path already
        // recorded fetch_log + source counter updates, so retry is safe.
        if (result.status === "error") {
          throw new Error(`fetch ${source.slug}: ${result.error}`);
        }
        return result;
      });

      // Exhaustive switch on fetch result status. `"delegated"` means the
      // source was handed off to the managed-agent worker — the MA session
      // writes its own fetch_log row when it completes, so we exit early here
      // rather than running the embed / cache-invalidation steps with zero rows.
      // The `default` arm ensures a future addition to FetchOneResult is a
      // compile-time error if this switch isn't updated.
      switch (fetchResult.status) {
        case "delegated":
          logEvent("info", {
            component: "poll-fetch-workflow",
            event: "delegated",
            sourceId,
            sessionId: fetchResult.sessionId,
          });
          return;
        case "no_change":
        case "dry_run":
        case "success":
          break;
        default: {
          const _exhaustive: never = fetchResult;
          throw new Error(`Unhandled FetchOneResult status: ${JSON.stringify(_exhaustive)}`);
        }
      }

      const insertedIds = fetchResult.insertedIds ?? [];

      // Runs before embed so (a) the AI headline doesn't get embedded as a
      // separate signal, and (b) the new content_* fields land before the
      // row reaches release-event observers.
      if (insertedIds.length > 0) {
        currentStep = "generate-content";
        await step.do("generate-content", RETRY_GENERATE, async () => {
          await generateContentForReleases(db, env, source, insertedIds);
        });
      }

      // Embed new releases. Retry-heavy — this is the failure mode the workflow
      // exists to solve. `throwOnError` makes the embed helper re-throw after
      // logging so the step picks up the failure.
      currentStep = "embed-releases";
      if (insertedIds.length > 0 && env.RELEASES_INDEX) {
        await step.do("embed-releases", RETRY_EMBED, async () => {
          await embedReleasesForSource(db, source, insertedIds, fetchEnv, { throwOnError: true });
        });
      }

      // Refresh GitHub CHANGELOG mirror + embed chunks. Runs in two steps so a
      // retry on embed doesn't re-fetch the repo tree. `skipEmbed` defers the
      // embed loop to the next step. Also covers `metadata.githubUrl`-override
      // scrape sources so the changelog file gets mirrored either way (#831).
      if (isGitHubFetched(source, sourceMeta)) {
        currentStep = "refresh-changelog-file";
        const refreshResult = await step.do("refresh-changelog-file", RETRY_FETCH, async () => {
          return await refreshChangelogFile(db, source, fetchEnv.GITHUB_TOKEN, fetchEnv, {
            skipEmbed: true,
          });
        });

        if (refreshResult.changedFiles.length > 0 && env.CHANGELOG_CHUNKS_INDEX) {
          currentStep = "embed-changelog-chunks";
          await step.do("embed-changelog-chunks", RETRY_EMBED, async () => {
            for (const file of refreshResult.changedFiles) {
              // oxlint-disable-next-line no-await-in-loop -- sequential per-file embed to avoid flooding the embedding provider
              await embedChangelogFileForSource(db, source, file, fetchEnv, { throwOnError: true });
            }
          });
        }
      }

      // Purge latest-cache when we actually inserted rows. Per-source
      // invalidation replaces the cron-aggregated call (see #486) — KV writes
      // are cheap and idempotent.
      if (fetchResult.releasesInserted > 0) {
        currentStep = "invalidate-latest-cache";
        await step.do("invalidate-latest-cache", async () => {
          await invalidateLatestCache(env, {
            nReleases: fetchResult.releasesInserted,
            cause: source.id,
          });
        });
      }

      logEvent("info", {
        component: "poll-fetch-workflow",
        event: "done",
        sourceSlug: source.slug,
        inserted: fetchResult.releasesInserted,
        found: fetchResult.releasesFound,
      });
    } catch (err) {
      // Source deleted between fan-out dispatch and workflow start — expected
      // race. Return cleanly so the instance ends in a `Completed` state
      // instead of `Errored` (which would also trigger an alert email).
      if (err instanceof NonRetryableError && err.message === SOURCE_DELETED_SENTINEL) {
        logEvent("info", {
          component: "poll-fetch-workflow",
          event: "source-deleted-race",
          sourceId,
        });
        return;
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      logEvent("error", {
        component: "poll-fetch-workflow",
        event: "step-failed",
        sourceId,
        step: currentStep,
        err,
        ...dbErrorLogFields(err),
      });
      await recordWorkflowFailure(db, {
        idPrefix: "wf-fail-",
        scheduledTime,
        sourceId,
        stepName: currentStep,
        error: errorMsg,
        logTag: "poll-fetch-workflow",
      });
      throw err;
    }
  }
}
