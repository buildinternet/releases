/**
 * Workflow-based replacement for the 2-hourly `pollAndFetch` cron. The
 * cron handler fans out one instance per due source; each instance walks
 * the ingest pipeline with a `step.do` boundary around each phase so a
 * transient failure (especially mid-embed Voyage 429s) no longer silently
 * drops vectors. See issue #486.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import {
  SOURCE_DELETED_SENTINEL,
  RATE_LIMITED_SENTINEL,
  isRateLimited,
  isDurableObjectReset,
  recordWorkflowFailure,
} from "./_shared.js";
import { logEvent } from "@releases/lib/log-event";
import { dbErrorLogFields } from "@releases/lib/db-errors";
import {
  fetchOne,
  pollOne,
  embedChangelogFileForSource,
  refreshChangelogFile,
  loadPlaybookNotesForSources,
} from "../cron/poll-fetch.js";
import { getSourceMeta, isGitHubFetched } from "@releases/adapters/feed.js";
import { type InvalidationEnv } from "../lib/latest-cache.js";
import {
  RETRY_POLL,
  RETRY_FETCH,
  RETRY_EMBED,
  RETRY_GENERATE,
  resolveFetchEnv,
  generateContentForReleases,
  runContentAndEmbedSteps,
  runInvalidateLatestCacheStep,
} from "../lib/ingest-steps.js";
// Back-compat re-exports: existing importers (backfill-source, batch-enrich,
// routes/workflows, tests) still import these shared primitives from this
// module. Their canonical home is now lib/ingest-steps.ts (#1946 phase 3).
export {
  RETRY_POLL,
  RETRY_FETCH,
  RETRY_EMBED,
  RETRY_GENERATE,
  resolveFetchEnv,
  generateContentForReleases,
};
import { type AnthropicEnv } from "../lib/anthropic.js";
import { makeBotFetch } from "../lib/web-bot-auth-fetch.js";

/**
 * Environment for the workflow. Bindings follow the same shape as the API
 * worker Env — secrets stay as SecretBinding here and are resolved inside
 * the step closures that consume them so they never land in instance state.
 */
export type PollAndFetchWorkflowEnv = InvalidationEnv &
  AnthropicEnv & {
    DB: D1Database;
    CRON_ENABLED?: string;
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
    // Deterministic-update dispatch bindings (#1946), forwarded into
    // FetchOneEnv so summary-only crawl-enabled feeds can delegate to the
    // update workflow (LATEST_CACHE + FLAGS ride on InvalidationEnv above).
    DETERMINISTIC_UPDATE_WORKFLOW?: Workflow;
    SOURCE_ACTOR?: DurableObjectNamespace;
    /**
     * Per-org drain actor (#1946 phase 2): when the poll step flags a scrape/
     * agent source, `pollOne` arms this OrgActor immediately instead of leaving
     * the arming to the source's next `SourceActor` alarm.
     */
    ORG_ACTOR?: DurableObjectNamespace<import("../org-actor.js").OrgActor>;
    STATUS_HUB?: DurableObjectNamespace;
    MA_SESSIONS_DISABLED?: string;
    MA_DAILY_SPEND_CAP_ORG_CENTS?: string;
    MA_DAILY_SPEND_CAP_GLOBAL_CENTS?: string;
    WEB_BOT_AUTH_ENABLED?: string;
    WEB_BOT_AUTH_PRIVATE_KEY?: { get(): Promise<string> };
    /**
     * Ingest-time feed-content enrichment (mirrors `FetchOneEnv`): the kill switch
     * + tuning knobs, plus the Cloudflare Browser-Rendering creds enrichment
     * escalates to when the cheap fetch is still thin. `resolveFetchEnv` forwards
     * these into the `FetchOneEnv` it hands `fetchOne`; without them the workflow
     * ingest path cannot run enrichment or the marketing classifier (the Anthropic
     * key + gateway opts ride on the `AnthropicEnv` intersection above).
     */
    FEED_ENRICH_ENABLED?: string;
    FEED_ENRICH_MAX_PER_FIRE?: string;
    FEED_THIN_CHARS?: string;
    CLOUDFLARE_ACCOUNT_ID?: { get(): Promise<string> };
    CLOUDFLARE_API_TOKEN?: { get(): Promise<string> };
    /** Ingest-time R2 media upload (#1177): `released-media` bucket. */
    MEDIA?: R2Bucket;
    /** Staleness horizon for the poll-path self-flag producer (default 72h). */
    FORCE_DRAIN_STALE_HOURS?: string;
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
      // Scrape/agent change-detection (#517) is always on now.
      const changeDetectEnabled = true;

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
        const staleHours = Number(env.FORCE_DRAIN_STALE_HOURS ?? 72);
        const drainSelfFlag =
          source.type === "scrape" || source.type === "agent"
            ? { staleHours: Number.isFinite(staleHours) && staleHours > 0 ? staleHours : 72 }
            : undefined;
        return await pollOne(db, source, now, {
          changeDetectEnabled,
          playbookNotes: source.orgId ? (notesByOrg.get(source.orgId) ?? null) : null,
          signedFetch: await makeBotFetch(env),
          drainSelfFlag,
          // #1946 phase 2: arm the OrgActor drain the instant this poll flags a
          // scrape/agent source, removing the up-to-one-tier-interval arming lag.
          drainOrgActor: env.ORG_ACTOR,
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

      // Scrape-no-feed / agent sources: pollOne already wrote `changeDetectedAt`
      // (via the `drainSelfFlag` above), and the OrgActor/SourceActor drain
      // dispatches an `/update` session for those. Calling fetchOne here would
      // fail with "Missing feedUrl or feedType" because there's no feed to
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
        // A transient feed rate-limit/timeout (429/408) is expected churn:
        // fetchOne already stamped the backoff, so throw NON-retryable (retrying
        // only deepens the rate-limit) with the sentinel the catch swallows
        // without recording a failure — no alert email.
        if (result.status === "error" && result.rateLimited) {
          throw new NonRetryableError(`${RATE_LIMITED_SENTINEL}: ${source.slug}: ${result.error}`);
        }
        // Surface other fetch errors so the step retries. The inline path
        // already recorded fetch_log + source counter updates, so retry is safe.
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

      // generate-content → embed-releases, in that order (shared with the
      // firecrawl webhook path via lib/ingest-steps so the two can't drift —
      // see #1955/#1946). `onStep` keeps `currentStep` accurate for the
      // failure-context row.
      await runContentAndEmbedSteps(step, { db, env, source, insertedIds, fetchEnv }, (name) => {
        currentStep = name;
      });

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

      // Purge latest-cache when we actually inserted rows (shared with the
      // firecrawl path via lib/ingest-steps). Per-source invalidation replaces
      // the cron-aggregated call (see #486) — KV writes are cheap + idempotent.
      await runInvalidateLatestCacheStep(
        step,
        env,
        source,
        fetchResult.releasesInserted,
        (name) => {
          currentStep = name;
        },
      );

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

      // Transient feed rate-limit/timeout (429/408): fetchOne already stamped
      // the backoff. Return cleanly (instance ends `Completed`, not `Errored`)
      // so it skips the `workflow_failures` row and its alert email — a
      // rate-limited feed is expected churn, not an actionable failure.
      if (err instanceof NonRetryableError && isRateLimited(errorMsg)) {
        logEvent("warn", {
          component: "poll-fetch-workflow",
          event: "feed-rate-limited",
          sourceId,
          step: currentStep,
        });
        return;
      }

      // Durable Object reset (a deploy landed mid-fire): transient infra churn,
      // not a source failure. The Workflows engine resumes the instance on the
      // new code and the source completes within the same fire (verified: reset
      // → `done` ~5 min later, nothing missed). Log it for visibility but skip
      // the error-level `step-failed` + the `workflow_failures` row that would
      // otherwise drive a false-alarm alert email. Re-throw is preserved so the
      // engine's resume/retry path is untouched.
      if (isDurableObjectReset(errorMsg)) {
        logEvent("warn", {
          component: "poll-fetch-workflow",
          event: "do-reset-transient",
          sourceId,
          step: currentStep,
        });
        throw err;
      }

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
