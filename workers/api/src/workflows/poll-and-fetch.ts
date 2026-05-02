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
import { eq } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import { SOURCE_DELETED_SENTINEL, recordWorkflowFailure } from "./_shared.js";
import {
  fetchOne,
  pollOne,
  embedReleasesForSource,
  embedChangelogFileForSource,
  refreshChangelogFile,
  loadPlaybookNotesForSources,
  type FetchOneEnv,
} from "../cron/poll-fetch.js";
import { getSourceMeta } from "@releases/adapters/feed.js";
import { invalidateLatestCache, type InvalidationEnv } from "../lib/latest-cache.js";

/**
 * Environment for the workflow. Bindings follow the same shape as the API
 * worker Env — secrets stay as SecretBinding here and are resolved inside
 * the step closures that consume them so they never land in instance state.
 */
export type PollAndFetchWorkflowEnv = InvalidationEnv & {
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
const RETRY_POLL = {
  retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

const RETRY_FETCH = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} satisfies WorkflowStepConfig;

const RETRY_EMBED = {
  retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} satisfies WorkflowStepConfig;

/**
 * Resolve the FetchOneEnv slice — embedding + GitHub + vector bindings — once
 * and cache it across steps. Secrets are fetched lazily inside steps that
 * need them (none of them here land in the workflow's persisted state because
 * the returned object only flows through closures).
 */
async function resolveFetchEnv(env: PollAndFetchWorkflowEnv): Promise<FetchOneEnv> {
  const githubToken = await env.GITHUB_TOKEN?.get().catch(() => undefined);
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
  };
}

export class PollAndFetchWorkflow extends WorkflowEntrypoint<
  PollAndFetchWorkflowEnv,
  PollAndFetchParams
> {
  async run(event: WorkflowEvent<PollAndFetchParams>, step: WorkflowStep): Promise<void> {
    const env = this.env;

    if (env.CRON_ENABLED === "false") {
      console.log("[poll-fetch-workflow] CRON_ENABLED=false; skipping");
      return;
    }

    const { sourceId, scheduledTime } = event.payload;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = env._drizzleOverride ?? drizzle(env.DB);

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

      const now = new Date();
      const changeDetectEnabled = env.SCRAPE_CHANGE_DETECT_ENABLED === "true";

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
        });
      });

      if (!pollResult.changed) {
        console.log(`[poll-fetch-workflow] ${source.slug}: no change detected`);
        return;
      }

      // Scrape-no-feed / agent sources: pollOne already wrote `changeDetectedAt`,
      // and the daily scrape-agent sweep cron drains those. Calling fetchOne here
      // would fail with "Missing feedUrl or feedType" because there's no feed to
      // hit — mirror the inline `pollAndFetch` filter. Falsy check (not `!= null`)
      // matches the gate inside fetchOne (poll-fetch.ts:446) so an empty-string
      // feedUrl can't slip past either. See #486 / #517.
      if ((source.type === "scrape" || source.type === "agent") && !getSourceMeta(source).feedUrl) {
        console.log(
          `[poll-fetch-workflow] ${source.slug}: changed; deferring to scrape-agent sweep`,
        );
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
          throw new Error(`fetch ${source.slug}: ${result.error ?? "unknown"}`);
        }
        return result;
      });

      // Embed new releases. Retry-heavy — this is the failure mode the workflow
      // exists to solve. `throwOnError` makes the embed helper re-throw after
      // logging so the step picks up the failure.
      currentStep = "embed-releases";
      const insertedIds = fetchResult.insertedIds ?? [];
      if (insertedIds.length > 0 && env.RELEASES_INDEX) {
        await step.do("embed-releases", RETRY_EMBED, async () => {
          await embedReleasesForSource(db, source, insertedIds, fetchEnv, { throwOnError: true });
        });
      }

      // Refresh GitHub CHANGELOG mirror + embed chunks. Runs in two steps so a
      // retry on embed doesn't re-fetch the repo tree. `skipEmbed` defers the
      // embed loop to the next step.
      if (source.type === "github") {
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
            sourceId: source.id,
          });
        });
      }

      console.log(
        `[poll-fetch-workflow] ${source.slug}: done (inserted=${fetchResult.releasesInserted}, found=${fetchResult.releasesFound})`,
      );
    } catch (err) {
      const isDeletedSourceRace =
        err instanceof NonRetryableError && err.message === SOURCE_DELETED_SENTINEL;
      if (!isDeletedSourceRace) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[poll-fetch-workflow] ${sourceId} failed at ${currentStep}: ${errorMsg}`);
        await recordWorkflowFailure(db, {
          idPrefix: "wf-fail-",
          scheduledTime,
          sourceId,
          stepName: currentStep,
          error: errorMsg,
          logTag: "poll-fetch-workflow",
        });
      }
      throw err;
    }
  }
}
