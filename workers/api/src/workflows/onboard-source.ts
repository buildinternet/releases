/**
 * Workflow-based replacement for the post-create onboarding tail. Today
 * `POST /v1/sources` rides `c.executionCtx.waitUntil(...)` for playbook
 * regeneration + entity embed, so a Worker eviction mid-tail leaves the
 * source DB-present without a playbook or entity vector. This workflow
 * makes those steps durable and folds the backfill fetch into the same
 * chain when the source type supports server-side ingest. See issue #493.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import { SOURCE_DELETED_SENTINEL, recordWorkflowFailure } from "./_shared.js";
import { regeneratePlaybook } from "../playbook-regen.js";
import { embedSourceSideEffect } from "../routes/sources.js";
import { fetchOne, embedReleasesForSource, type FetchOneEnv } from "../cron/poll-fetch.js";
import { getSourceMeta } from "@releases/adapters/feed.js";
import { invalidateLatestCache, type InvalidationEnv } from "../lib/latest-cache.js";
import { logEvent } from "@releases/lib/log-event";

export type OnboardSourceWorkflowEnv = InvalidationEnv & {
  DB: D1Database;
  GITHUB_TOKEN?: { get(): Promise<string> };
  RELEASES_INDEX?: unknown;
  ENTITIES_INDEX?: unknown;
  CHANGELOG_CHUNKS_INDEX?: unknown;
  EMBEDDING_PROVIDER?: string;
  VOYAGE_API_KEY?: { get(): Promise<string> };
  OPENAI_API_KEY?: { get(): Promise<string> };
  RELEASE_HUB?: DurableObjectNamespace;
  WEBHOOK_DELIVERY_QUEUE?: Queue<unknown>;
  /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
  _drizzleOverride?: unknown;
};

export type OnboardSourceParams = {
  sourceId: string;
  /** Skip the backfill-fetch step. Driven by `X-Onboard-Mode: manual`. */
  skipBackfill?: boolean;
};

const RETRY_PLAYBOOK = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

const RETRY_EMBED = {
  retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} satisfies WorkflowStepConfig;

const RETRY_FETCH = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} satisfies WorkflowStepConfig;

async function resolveFetchEnv(env: OnboardSourceWorkflowEnv): Promise<FetchOneEnv> {
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

export class OnboardSourceWorkflow extends WorkflowEntrypoint<
  OnboardSourceWorkflowEnv,
  OnboardSourceParams
> {
  async run(event: WorkflowEvent<OnboardSourceParams>, step: WorkflowStep): Promise<void> {
    const env = this.env;
    const { sourceId, skipBackfill = false } = event.payload;
    const scheduledTime = event.timestamp.getTime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = env._drizzleOverride ?? drizzle(env.DB);

    let currentStep = "load-source";

    try {
      const source = await step.do("load-source", async () => {
        const [row]: Source[] = await db.select().from(sources).where(eq(sources.id, sourceId));
        if (!row) throw new NonRetryableError(SOURCE_DELETED_SENTINEL);
        return row;
      });

      if (source.orgId) {
        currentStep = "regenerate-playbook";
        await step.do("regenerate-playbook", RETRY_PLAYBOOK, async () => {
          await regeneratePlaybook(db, source.orgId!, { throwOnError: true });
        });
      }

      currentStep = "embed-source";
      await step.do("embed-source", RETRY_EMBED, async () => {
        await embedSourceSideEffect(
          env as Parameters<typeof embedSourceSideEffect>[0],
          db,
          sourceId,
          { throwOnError: true },
        );
      });

      // Backfill — only for source types that ingest server-side. Scrape-no-feed
      // and agent sources are picked up by the daily scrape-agent sweep.
      if (!skipBackfill) {
        const meta = getSourceMeta(source);
        const serverSideFetchable =
          source.type === "feed" ||
          source.type === "github" ||
          (source.type === "scrape" && meta.feedUrl != null);

        if (serverSideFetchable) {
          const fetchEnv = await resolveFetchEnv(env);

          // Fetch + parse + persist. `skipSideEffects` defers the inline embed
          // loop to the next step so a backfill on a 1000-release CHANGELOG
          // can't bust the 5-min step timeout, and an embed retry doesn't
          // re-fetch the upstream feed.
          currentStep = "backfill-fetch";
          const fetchResult = await step.do("backfill-fetch", RETRY_FETCH, async () => {
            const result = await fetchOne(db, source, fetchEnv, { skipSideEffects: true });
            if (result.status === "error") {
              throw new Error(`backfill ${source.slug}: ${result.error ?? "unknown"}`);
            }
            return result;
          });

          const insertedIds = fetchResult.insertedIds ?? [];
          if (insertedIds.length > 0 && env.RELEASES_INDEX) {
            currentStep = "embed-releases";
            await step.do("embed-releases", RETRY_EMBED, async () => {
              await embedReleasesForSource(db, source, insertedIds, fetchEnv, {
                throwOnError: true,
              });
            });
          }

          if (fetchResult.releasesInserted > 0) {
            currentStep = "invalidate-latest-cache";
            await step.do("invalidate-latest-cache", async () => {
              await invalidateLatestCache(env, {
                nReleases: fetchResult.releasesInserted,
                sourceId: source.id,
              });
            });
          }
        } else {
          logEvent("info", {
            component: "onboard-workflow",
            event: "defer-backfill-to-scrape-agent",
            sourceSlug: source.slug,
          });
        }
      }

      logEvent("info", {
        component: "onboard-workflow",
        event: "done",
        sourceSlug: source.slug,
        skipBackfill,
      });
    } catch (err) {
      // Source deleted between dispatch and workflow start — expected race.
      // Return cleanly so the instance ends `Completed` rather than `Errored`.
      if (err instanceof NonRetryableError && err.message === SOURCE_DELETED_SENTINEL) {
        logEvent("info", {
          component: "onboard-workflow",
          event: "source-deleted-race",
          sourceId,
        });
        return;
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      logEvent("error", {
        component: "onboard-workflow",
        event: "step-failed",
        sourceId,
        step: currentStep,
        err,
      });
      await recordWorkflowFailure(db, {
        idPrefix: "wf-fail-onboard-",
        scheduledTime,
        sourceId,
        stepName: currentStep,
        error: errorMsg,
        logTag: "onboard-workflow",
      });
      throw err;
    }
  }
}
