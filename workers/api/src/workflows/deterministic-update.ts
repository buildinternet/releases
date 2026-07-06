/**
 * Deterministic per-source update workflow (#1946, phase 1 of the ingest
 * consolidation).
 *
 * Relocates the drain-path execution that lived in the discovery worker's
 * `ManagedAgentsSession.runDeterministicUpdate` (#1878): a routine update run
 * is a plain `scrapeFetch` loop — no coordinator, no Anthropic session — so it
 * now runs as an API-worker workflow, one `step.do` per source. Dispatch (kill
 * switch, spend cap, per-source lock, StatusHub session:start) happens in
 * `lib/update-dispatch.ts` before the instance is created.
 *
 * Behavior parity with the retired discovery path:
 *   - `scrapeFetch` still persists through the HTTP API surface — via the
 *     `API_SELF` self service binding, which reproduces the discovery→api
 *     service-binding semantics (own invocation per call, auth middleware,
 *     waitUntil lifetimes) exactly. Direct-DB persistence is the phase-3
 *     consolidation, not this change.
 *   - A run where every processed source failed reports `session:error` with
 *     the same `classifyUsFatal` classification; otherwise `session:complete`
 *     with the `mode: "update-deterministic"` result record.
 *   - Locks release in a `finally`; the SourceActor 15-min lease is the
 *     backstop if the instance dies mid-run.
 *
 * What changed: the old loop ran inside one DO alarm under a 12-min wall-clock
 * budget (sources past the budget were skipped). Each source is now its own
 * workflow step with a per-step timeout, so the batch-level budget (and its
 * skipped-sources accounting) is gone — every source in the batch runs.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { scrapeFetch, type ScrapeEnv } from "@releases/adapters/scrape-fetch";
import { runScrapeFetchLoop } from "@releases/adapters/deterministic-update";
import { classifyUsFatal } from "@releases/lib/session-error-classify";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import { getSecret, getSecretWithFallback, type SecretBinding } from "@releases/lib/secrets";
import { createDb } from "../db.js";
import { d1ScrapePersister } from "../lib/d1-scrape-persister.js";
import {
  runContentAndEmbedSteps,
  runInvalidateLatestCacheStep,
  resolveFetchEnv,
} from "../lib/ingest-steps.js";
import type { PollAndFetchWorkflowEnv } from "./poll-and-fetch.js";
import { makeBotFetch } from "../lib/web-bot-auth-fetch.js";
import { releaseSourceLocks } from "../lib/source-lock.js";
import { notifyUpdateStatusHub } from "../lib/update-dispatch.js";
import type { MediaTransformBinding } from "../lib/media-ingest.js";

export interface DeterministicUpdateWorkflowEnv {
  /**
   * Self service binding (this worker). Only the extraction-time HTTP calls
   * (content-hash, playbook, usage log via `buildWorkerExtractDeps`'s
   * `ExtractRepo`) still route through this — persistence itself moved to the
   * direct-D1 persister below (#1946 phase 4, task 8). Out of scope: draining
   * `ExtractRepo` off HTTP is a later task.
   */
  API_SELF?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  RELEASES_API_KEY?: SecretBinding;
  RELEASED_API_KEY?: SecretBinding;
  /** Staging gate key — attached to self-calls so they clear the gate on api-staging. */
  STAGING_ACCESS_KEY?: SecretBinding;
  ANTHROPIC_API_KEY?: SecretBinding;
  ANTHROPIC_BASE_URL?: string;
  AI_GATEWAY_TOKEN?: SecretBinding;
  CLOUDFLARE_ACCOUNT_ID?: SecretBinding;
  CLOUDFLARE_API_TOKEN?: SecretBinding;
  FLAGS?: FlagshipBinding;
  EXTRACT_TOOLLOOP_ENABLED?: string;
  RAW_SNAPSHOT_CAPTURE_ENABLED?: string;
  /** OpenRouter extraction lane (#1536) — same fail-open contract as discovery. */
  OPENROUTER_ENABLED?: string;
  // Narrowed to the non-nullable get() the ScrapeEnv / WebBotAuthEnv seams
  // declare (mirrors `_fetch-env.ts`); the Secrets Store binding satisfies it.
  OPENROUTER_API_KEY?: { get(): Promise<string> };
  OPENROUTER_BASE_URL?: string;
  EXTRACT_MODEL?: string;
  WEB_BOT_AUTH_ENABLED?: string;
  WEB_BOT_AUTH_PRIVATE_KEY?: { get(): Promise<string> };
  STATUS_HUB?: DurableObjectNamespace;
  SOURCE_ACTOR?: DurableObjectNamespace;

  // Direct-D1 persistence + post-insert step bindings (#1946 phase 4). The
  // workflow shares the worker's bindings at runtime; this interface only
  // needs to declare the slice `d1ScrapePersister` + `ingest-steps` consume —
  // mirrors `PollAndFetchWorkflowEnv` (workers/api/src/workflows/poll-and-fetch.ts).
  DB?: D1Database;
  // Non-optional to satisfy `BatchEffectsEnv`/`PublishEnv` (release-batch-ingest.ts),
  // which `d1ScrapePersister` requires — mirrors those interfaces exactly.
  RELEASES_INDEX: unknown;
  RELEASE_HUB: DurableObjectNamespace;
  CHANGELOG_CHUNKS_INDEX?: unknown;
  EMBEDDING_PROVIDER?: string;
  VOYAGE_API_KEY?: { get(): Promise<string> };
  OPENAI_API_KEY?: { get(): Promise<string> };
  WEBHOOK_DELIVERY_QUEUE?: Queue<unknown>;
  GITHUB_TOKEN?: { get(): Promise<string> };
  MEDIA?: R2Bucket;
  MEDIA_TRANSFORM?: MediaTransformBinding;
  MEDIA_GIF_TRANSCODE_ENABLED?: string;
  FEED_ENRICH_ENABLED?: string;
  FEED_ENRICH_MAX_PER_FIRE?: string;
  FEED_THIN_CHARS?: string;
  LATEST_CACHE?: KVNamespace;
  /** Ephemeral raw-page snapshot bucket (`released-raw`) — mirrors `D1PersisterEnv`. */
  RAW_SNAPSHOTS?: R2Bucket;
  /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
  _drizzleOverride?: unknown;
}

export type DeterministicUpdateParams = {
  /** Minted by the dispatcher; owns the per-source leases and the StatusHub row. */
  sessionId: string;
  company: string;
  sourceIdentifiers: string[];
  orgId?: string;
  correlationId?: string;
};

/**
 * One source per step. No automatic retry beyond a single infra-blip attempt:
 * `scrapeFetch` already normalizes handled failures into `Error [category]`
 * result strings (the step returns, doesn't throw), so a step-level throw is a
 * transport/infra failure. Extraction is re-billed on retry, so keep it to 1.
 */
const FETCH_STEP: WorkflowStepConfig = {
  retries: { limit: 1, delay: "30 seconds", backoff: "exponential" },
  timeout: "15 minutes",
};

const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}

export class DeterministicUpdateWorkflow extends WorkflowEntrypoint<
  DeterministicUpdateWorkflowEnv,
  DeterministicUpdateParams
> {
  async run(event: WorkflowEvent<DeterministicUpdateParams>, step: WorkflowStep) {
    const { sessionId, company, sourceIdentifiers, orgId } = event.payload;
    const env = this.env;

    try {
      const scrapeEnv = await this.buildScrapeEnv(sessionId);
      if (!scrapeEnv) {
        // Scrape secrets absent (local dev / misconfig) — terminal failure,
        // matching the discovery path's fail-closed behavior.
        await notifyUpdateStatusHub(env, {
          type: "session:error",
          sessionId,
          company,
          error: "scrape secrets not configured",
          errorSource: "us",
        });
        return;
      }

      const summary = await runScrapeFetchLoop(
        sourceIdentifiers,
        (source) => step.do(`fetch:${source}`, FETCH_STEP, () => scrapeFetch(scrapeEnv, source)),
        // Sequencing + result normalization reuse the shared loop; the
        // wall-clock budget was a DO-session artifact — steps carry their own
        // timeout now, so the batch budget is effectively unbounded.
        { budgetMs: Number.POSITIVE_INFINITY },
      );

      // Post-insert summarize/embed/invalidate chain (#1946 phase 4, task 8) —
      // same steps the poll-and-fetch workflow runs, now that persistence is
      // direct-D1 instead of going through the HTTP self-call. Run per source
      // that actually inserted rows this fetch. A failure here must NOT fail
      // the already-persisted run — the fetch + insert already succeeded.
      const sourcesWithInserts = summary.results.filter(
        (r) => r.ok && (r.insertedIds?.length ?? 0) > 0,
      );
      if (sourcesWithInserts.length > 0) {
        const stepEnv = this.buildStepEnv();
        const db = stepEnv.DB ? createDb(stepEnv.DB) : createDb(env._drizzleOverride as D1Database);
        const fetchEnv = await resolveFetchEnv(stepEnv);

        for (const result of sourcesWithInserts) {
          const insertedIds = result.insertedIds ?? [];
          try {
            // Reuse the same persister the fetch step used — its `getSource`
            // already handles src_<id> / org-slug / bare-slug forms
            // identically to `sourceIdentifiers`, so this can't drift from
            // what actually got fetched.
            const sourceRow = await scrapeEnv.persister!.getSource(result.source);
            if (!sourceRow) {
              logEvent("warn", {
                component: "deterministic-update",
                event: "post-insert-source-not-found",
                sessionId,
                source: result.source,
              });
              continue;
            }

            // Cloudflare Workflows dedupe `step.do` by name, and this single
            // instance processes many sources — namespace every step name
            // under the source identifier so steps from different sources
            // never collide.
            const nsStep = {
              ...step,
              do: ((name: string, a: unknown, b?: unknown) =>
                (step.do as (...args: unknown[]) => Promise<unknown>)(
                  `${result.source}:${name}`,
                  a,
                  b,
                )) as WorkflowStep["do"],
            } as WorkflowStep;

            await runContentAndEmbedSteps(nsStep, {
              db,
              env: stepEnv,
              source: sourceRow,
              insertedIds,
              fetchEnv,
            });
            await runInvalidateLatestCacheStep(nsStep, stepEnv, sourceRow, insertedIds.length);
          } catch (err) {
            logEvent("warn", {
              component: "deterministic-update",
              event: "post-insert-steps-failed",
              sessionId,
              source: result.source,
              err: err instanceof Error ? err : String(err),
            });
          }
        }
      }

      const counts = {
        sourcesProcessed: summary.sourcesProcessed,
        sourcesSkipped: summary.sourcesSkipped,
        releasesFound: summary.totalReleasesFound,
        releasesInserted: summary.totalReleasesInserted,
        errorCount: summary.errorCount,
      };

      logEvent("info", {
        component: "deterministic-update",
        event: "deterministic-update-complete",
        sessionId,
        company,
        ...(orgId ? { orgId } : {}),
        ...counts,
      });

      // Every processed source failed (and at least one ran) → terminal
      // failure, mirroring the retired agent path's "all tool calls failed".
      if (summary.sourcesProcessed > 0 && summary.errorCount >= summary.sourcesProcessed) {
        const firstError = summary.results.find((r) => !r.ok);
        const detail = firstError?.error
          ? `All ${summary.errorCount} source fetch(es) failed: ${truncate(firstError.error, 120)}`
          : `All ${summary.errorCount} source fetch(es) failed`;
        const classification = classifyUsFatal(firstError?.errorCategory, detail);
        await notifyUpdateStatusHub(env, {
          type: "session:error",
          sessionId,
          company,
          error: detail,
          errorSource: classification?.errorSource ?? "us",
          ...(classification?.errorType ? { errorType: classification.errorType } : {}),
        });
        return;
      }

      await notifyUpdateStatusHub(env, {
        type: "session:complete",
        sessionId,
        company,
        result: { mode: "update-deterministic", ...counts },
      });
    } finally {
      // Release the per-source leases the dispatcher acquired under this
      // sessionId (#1814). Conditional + idempotent on the SourceActor side,
      // so a replayed run() re-releasing is a no-op; the 15-min lease is the
      // backstop if the instance dies before reaching this.
      await releaseSourceLocks(env, sourceIdentifiers, sessionId);
    }
  }

  /**
   * Resolve secrets + flags into the `ScrapeEnv` handed to every fetch step.
   * Returns null when the Cloudflare scrape creds are absent — the caller
   * fails the run terminally rather than limping. Resolved once per run()
   * invocation (replays re-resolve; none of it lands in step state).
   */
  private async buildScrapeEnv(sessionId: string): Promise<ScrapeEnv | null> {
    const env = this.env;
    const [cfAccountId, cfApiToken, anthropicApiKey, releasesApiKey, gatewayToken, stagingKey] =
      await Promise.all([
        getSecret(env.CLOUDFLARE_ACCOUNT_ID).catch(() => null),
        getSecret(env.CLOUDFLARE_API_TOKEN).catch(() => null),
        getSecret(env.ANTHROPIC_API_KEY).catch(() => null),
        getSecretWithFallback(env.RELEASES_API_KEY, env.RELEASED_API_KEY).catch(() => null),
        getSecret(env.AI_GATEWAY_TOKEN).catch(() => null),
        getSecret(env.STAGING_ACCESS_KEY).catch(() => null),
      ]);
    if (!cfAccountId || !cfApiToken || !anthropicApiKey || !env.API_SELF) return null;

    const [extractToolLoopEnabled, captureRawSnapshots, openrouterEnabled, signedFetch] =
      await Promise.all([
        flag(env.FLAGS, env.EXTRACT_TOOLLOOP_ENABLED, FLAGS.extractToolLoopEnabled),
        flag(env.FLAGS, env.RAW_SNAPSHOT_CAPTURE_ENABLED, FLAGS.rawSnapshotCapture),
        flag(env.FLAGS, env.OPENROUTER_ENABLED, FLAGS.openrouterEnabled),
        makeBotFetch(env),
      ]);

    const self = env.API_SELF;
    const apiFetcher = {
      fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        // Pass only the composed Request — `fetch(req, init)` lets init.headers
        // silently override headers set here (#550). Extraction-only now
        // (content-hash, playbook, usage log via `buildWorkerExtractDeps`'s
        // `ExtractRepo`) — persistence moved to the direct-D1 persister below.
        const req = new Request(input, init);
        if (stagingKey) req.headers.set(STAGING_KEY_HEADER, stagingKey);
        return self.fetch(req);
      },
    };

    const db = createDb(env.DB ?? (env._drizzleOverride as D1Database));

    return {
      cloudflareAccountId: cfAccountId,
      cloudflareApiToken: cfApiToken,
      anthropicApiKey,
      anthropicBaseURL: env.ANTHROPIC_BASE_URL,
      aiGatewayToken: gatewayToken || undefined,
      apiFetcher,
      apiKey: releasesApiKey ?? "",
      sessionId,
      extractToolLoopEnabled,
      captureRawSnapshots,
      openrouterEnabled,
      openRouterApiKey: env.OPENROUTER_API_KEY,
      openRouterBaseURL: env.OPENROUTER_BASE_URL,
      extractModel: env.EXTRACT_MODEL,
      signedFetch,
      // Direct-D1 persistence (#1946 phase 4, task 6/8) — replaces the HTTP
      // self-call persister. `apiFetcher` above stays wired for the
      // extraction-time HTTP calls only.
      persister: d1ScrapePersister({ db, env, sessionId, captureRawSnapshots }),
    };
  }

  /**
   * Builds the `PollAndFetchWorkflowEnv`-shaped env the shared ingest-steps
   * helpers (`runContentAndEmbedSteps`/`resolveFetchEnv`) expect. Mirrors how
   * `poll-and-fetch.ts` constructs its own `env`/`fetchEnv` for the same
   * calls — this workflow processes many sources per instance rather than
   * one, so it's built once per run() and reused per source.
   */
  private buildStepEnv(): PollAndFetchWorkflowEnv {
    const env = this.env;
    return {
      ...env,
      DB: env.DB ?? (env._drizzleOverride as D1Database),
    } as unknown as PollAndFetchWorkflowEnv;
  }
}
