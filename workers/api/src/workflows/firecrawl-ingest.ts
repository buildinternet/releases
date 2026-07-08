/**
 * Workflow triggered when Firecrawl detects a change on a monitored source
 * (inbound webhook → POST /v1/integrations/firecrawl/webhook). Re-scrapes the
 * page via Firecrawl, extracts releases, inserts them through the standard
 * ingest tail (dedup → coverage → publish → IndexNow), then embeds and
 * optionally summarizes the new rows. See Phase 2 of the Firecrawl monitoring
 * integration plan.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createDb } from "../db.js";
import { eq } from "drizzle-orm";
import { sources, fetchLog } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/feed.js";
import { createFirecrawlClient } from "@releases/adapters/firecrawl.js";
import type { FirecrawlClient } from "@releases/adapters/firecrawl.js";
import type { RawRelease } from "@releases/adapters/types.js";
import { logEvent } from "@releases/lib/log-event";
import { getSecret } from "@releases/lib/secrets";
import { FirecrawlError } from "@releases/lib/errors";
import { getAnthropicKey, resolveGatewayOpts } from "../lib/anthropic.js";
import { resolveExtractAiSdkModel } from "../lib/extract-model.js";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { extractFirecrawlMarkdown } from "../lib/firecrawl-extract.js";
import { logUsage } from "../lib/usage-log.js";
import { ingestRawReleases, type FetchOneEnv } from "../cron/poll-fetch.js";
import {
  RETRY_POLL,
  RETRY_FETCH,
  resolveFetchEnv,
  runContentAndEmbedSteps,
  runInvalidateLatestCacheStep,
} from "../lib/ingest-steps.js";
import type { PollAndFetchWorkflowEnv } from "./poll-and-fetch.js";

// Model for Firecrawl extraction. Matches the standard cron ingest model
// (config.ingestModel default) rather than the heavier discovery agentModel:
// in steady state the workflow extracts only the diff delta (a few new
// entries), and even a baseline scrape is windowed to a recent slice, so the
// input is small and structured — Haiku parses it reliably at a fraction of
// Sonnet's cost. Extraction runs at temperature 0 (see extract-from-body) for
// reproducible parses.
const FIRECRAWL_EXTRACT_MODEL = "claude-haiku-4-5-20251001";

// record-failure writes a fetch_log row + bumps consecutiveErrors — neither is
// idempotent, so it runs as a single best-effort attempt (no retries). Retrying
// after a partial commit would write duplicate error rows / over-count errors
// on a transient D1 blip; the outer catch logs a recording failure and still
// re-throws the original error.
const NO_RETRY = {
  retries: { limit: 0, delay: "1 second", backoff: "constant" },
} satisfies WorkflowStepConfig;

/** Minimal logger passed to extractFirecrawlMarkdown. */
const workerLogger = {
  info: (msg: string) =>
    logEvent("info", {
      component: "firecrawl-ingest-workflow",
      event: "extract-info",
      message: msg,
    }),
  warn: (msg: string) =>
    logEvent("warn", {
      component: "firecrawl-ingest-workflow",
      event: "extract-warn",
      message: msg,
    }),
  debug: (msg: string) =>
    logEvent("info", {
      component: "firecrawl-ingest-workflow",
      event: "extract-debug",
      message: msg,
    }),
  error: (msg: string) =>
    logEvent("error", {
      component: "firecrawl-ingest-workflow",
      event: "extract-error",
      message: msg,
    }),
};

export interface FirecrawlIngestParams {
  /** Source row id to process. */
  sourceId: string;
  /** The changelog URL Firecrawl scraped. */
  url: string;
  /** The Firecrawl check/run id for this change event (observability). */
  checkId: string;
  /** Firecrawl event status (e.g. "new", "changed"). */
  status: string;
  /**
   * Pre-extracted added content from the webhook's diff, set on `changed`
   * events. When present the workflow extracts just this delta and skips the
   * full-page re-scrape; absent on `new`/baseline events, which scrape the page.
   */
  delta?: string;
}

export type FirecrawlIngestEnv = PollAndFetchWorkflowEnv & {
  FIRECRAWL_API_KEY?: { get(): Promise<string> };
  /** TEST-ONLY: inject a pre-built FirecrawlClient instead of constructing one. */
  _firecrawlClientOverride?: FirecrawlClient;
  /** TEST-ONLY: inject an extraction function instead of calling the LLM.
   *  `pageUrl` is the per-page attribution URL for crawl monitors (else undefined). */
  _extractOverride?: (markdown: string, source: Source, pageUrl?: string) => Promise<RawRelease[]>;
};

export class FirecrawlIngestWorkflow extends WorkflowEntrypoint<
  FirecrawlIngestEnv,
  FirecrawlIngestParams
> {
  async run(event: WorkflowEvent<FirecrawlIngestParams>, step: WorkflowStep): Promise<void> {
    const env = this.env;
    const { sourceId, url, checkId, status, delta } = event.payload;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern; same as poll-and-fetch
    const db: any = env._drizzleOverride ?? createDb(env.DB);

    // ── Step 1: load-source ─────────────────────────────────────────────────
    // Returns the row plus its derived per-page attribution URL so the source
    // metadata is parsed once here, not re-parsed outside the step.
    const { source, attributeUrl } = await step.do("load-source", RETRY_POLL, async () => {
      const [row]: Source[] = await db.select().from(sources).where(eq(sources.id, sourceId));
      if (!row) throw new NonRetryableError(`source ${sourceId} not found`);
      const meta = getSourceMeta(row);
      if (!meta.firecrawl?.enabled) {
        throw new NonRetryableError(
          `source ${sourceId} does not have firecrawl.enabled — refusing ingest`,
        );
      }
      // Crawl monitors report each discovered entry page on its OWN URL (distinct
      // from the index source.url), so attribute extracted releases to that bare
      // per-page URL — matching the in-repo crawl adapter's scheme so re-ingest
      // dedups instead of duplicating. Scrape monitors watch the single
      // source.url, so attributeUrl stays undefined and extraction keeps its
      // `${source.url}#${slug}` anchors (changing those would break existing
      // scrape-monitor dedup). See gap #2 of issue #1302.
      const pageUrl = meta.firecrawl.target === "crawl" ? url : undefined;
      return { source: row, attributeUrl: pageUrl };
    });

    // Everything past load-source depends on Firecrawl + Anthropic being
    // reachable. The happy-path `bookkeep` step is what records the run
    // (fetch_log row + counter reset), so a terminal failure before it would
    // otherwise leave NO DB trace and never bump consecutiveErrors — the
    // failure would only show in the CF Workflows dashboard. Wrap the pipeline
    // so an outage (out-of-credits, auth, 5xx) is recorded in the source's own
    // health. See resilience option B.
    try {
      // ── Step 2: resolve body (diff delta, else scrape the full page) ─────────
      // Named "resolve-body", not "scrape": on a `changed` event we return the
      // delta and never call Firecrawl, so the dashboard shouldn't imply a
      // (billed) scrape happened.
      const markdown = await step.do("resolve-body", RETRY_FETCH, async () => {
        // `changed` events arrive with the diff delta already in hand — extract
        // just that and skip the paid, full-page Firecrawl scrape. Only the
        // one-time `new`/baseline event (no delta) actually hits Firecrawl.
        if (delta) return delta;
        let client: FirecrawlClient;
        if (env._firecrawlClientOverride) {
          client = env._firecrawlClientOverride;
        } else {
          const apiKey = await getSecret(env.FIRECRAWL_API_KEY);
          if (!apiKey) throw new NonRetryableError("FIRECRAWL_API_KEY is not configured");
          client = createFirecrawlClient({ apiKey });
        }
        const sourceMeta = getSourceMeta(source);
        const md = await client.scrapeOnce(url, { proxy: sourceMeta.firecrawl?.proxy });
        if (!md) throw new Error(`empty scrape result for ${url}`);
        return md;
      });

      // ── Step 3: extract ─────────────────────────────────────────────────────
      const rawReleases = await step.do("extract", RETRY_FETCH, async () => {
        if (env._extractOverride) {
          return env._extractOverride(markdown, source, attributeUrl);
        }
        const apiKey = await getAnthropicKey(env);
        if (!apiKey) throw new NonRetryableError("ANTHROPIC_API_KEY is not configured");
        const anthropicClient = buildAnthropicClient({
          apiKey,
          ...(await resolveGatewayOpts(env)),
        });
        // OpenRouter extraction lane (issue #1536) — undefined unless the flag is
        // on + EXTRACT_MODEL + key are set. Inert here today (firecrawl extraction
        // never opts into the tool-loop), threaded for consistency + future use.
        const aiSdk = await resolveExtractAiSdkModel(env, FIRECRAWL_EXTRACT_MODEL);
        const result = await extractFirecrawlMarkdown(
          markdown,
          source,
          {
            anthropicClient,
            agentModel: FIRECRAWL_EXTRACT_MODEL,
            logger: workerLogger,
            logUsageFn: (entry) => logUsage(db, { ...entry, sourceId }, "firecrawl-ingest"),
            ...(aiSdk ? { aiSdkModel: aiSdk.model, aiSdkModelLabel: aiSdk.label } : {}),
          },
          { pageUrl: attributeUrl },
        );
        // No silent caps: when the input exceeded the recent-window budget (the
        // one-time baseline scrape, or a rare oversized diff), record how much
        // we trimmed so an operator can backfill if older entries are wanted.
        if (result.droppedChars > 0) {
          logEvent("info", {
            component: "firecrawl-ingest-workflow",
            event: "input-windowed",
            sourceId,
            checkId,
            droppedChars: result.droppedChars,
          });
        }
        return result.releases;
      });

      // ── Step 4: dedup-insert ─────────────────────────────────────────────────
      // resolveFetchEnv is cheap (one getSecret call for GITHUB_TOKEN) and
      // idempotent — resolve independently in each step that needs it so steps
      // remain self-contained and replay-safe.
      const ingest = await step.do("dedup-insert", RETRY_FETCH, async () => {
        const fetchEnv: FetchOneEnv = await resolveFetchEnv(env);
        return ingestRawReleases(db, source, rawReleases, fetchEnv);
      });

      // ── Steps 5a/5b/5c: post-insert side-effects (only when new rows landed) ──
      // Shared with the poll path via lib/ingest-steps so the two can't drift
      // (the drift these helpers close was fixed in #1955): generate-content runs
      // BEFORE embed-releases (don't embed the AI headline; land content_* before
      // release-event observers), then the latest-cache is purged. Same step
      // names + gating as before the extraction, so in-flight instances replay
      // cleanly. resolveFetchEnv is cheap + idempotent; it runs on each replay
      // outside a step, matching the poll path.
      const postInsertFetchEnv: FetchOneEnv = await resolveFetchEnv(env);
      await runContentAndEmbedSteps(step, {
        db,
        env,
        source,
        insertedIds: ingest.insertedIds,
        fetchEnv: postInsertFetchEnv,
      });
      await runInvalidateLatestCacheStep(step, env, source, ingest.inserted);

      // ── Step 6: bookkeep ─────────────────────────────────────────────────────
      await step.do("bookkeep", RETRY_POLL, async () => {
        const currentMeta = getSourceMeta(source);
        const nextMeta = {
          ...currentMeta,
          firecrawl: {
            ...currentMeta.firecrawl,
            enabled: true,
            lastCheckId: checkId,
            lastChangeAt: new Date().toISOString(),
          },
        };
        await db.batch([
          db.insert(fetchLog).values({
            sourceId,
            sessionId: `firecrawl:${checkId}`,
            releasesFound: ingest.found,
            releasesInserted: ingest.inserted,
            // durationMs intentionally omitted: a Workflow re-runs run() from the
            // top on each replay, so a top-level `Date.now()` start would only
            // measure the final leg. PollAndFetchWorkflow omits it for the same
            // reason; the column is nullable.
            status: ingest.inserted > 0 ? "success" : "no_change",
          }),
          db
            .update(sources)
            .set({
              lastFetchedAt: new Date().toISOString(),
              consecutiveNoChange: 0,
              consecutiveErrors: 0,
              nextFetchAfter: null,
              changeDetectedAt: null,
              metadata: JSON.stringify(nextMeta),
            })
            .where(eq(sources.id, sourceId)),
        ] as [unknown, ...unknown[]]);
      });

      logEvent("info", {
        component: "firecrawl-ingest-workflow",
        event: "ingested",
        sourceId,
        checkId,
        status,
        found: ingest.found,
        inserted: ingest.inserted,
      });
    } catch (err) {
      // Record the terminal failure in the source's own health. Best-effort:
      // a failure to record must not mask the original error, which we re-throw
      // so the instance is still marked failed for the CF dashboard.
      try {
        await step.do("record-failure", NO_RETRY, async () => {
          const fcStatus = err instanceof FirecrawlError ? err.status : null;
          const eventName =
            fcStatus === 402
              ? "credits-exhausted"
              : fcStatus === 401 || fcStatus === 403
                ? "auth-failed"
                : "ingest-failed";
          logEvent("error", {
            component: "firecrawl-ingest-workflow",
            event: eventName,
            sourceId,
            checkId,
            firecrawlStatus: fcStatus,
            err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
          });
          const [row] = await db
            .select({ consecutiveErrors: sources.consecutiveErrors })
            .from(sources)
            .where(eq(sources.id, sourceId));
          await db.batch([
            db.insert(fetchLog).values({
              sourceId,
              sessionId: `firecrawl:${checkId}`,
              releasesFound: 0,
              releasesInserted: 0,
              status: "error",
              error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
              errorCategory: "infra",
            }),
            db
              .update(sources)
              .set({ consecutiveErrors: (row?.consecutiveErrors ?? 0) + 1 })
              .where(eq(sources.id, sourceId)),
          ] as [unknown, ...unknown[]]);
        });
      } catch (recordErr) {
        logEvent("error", {
          component: "firecrawl-ingest-workflow",
          event: "record-failure-failed",
          sourceId,
          checkId,
          err:
            recordErr instanceof Error
              ? { name: recordErr.name, message: recordErr.message }
              : String(recordErr),
        });
      }
      throw err;
    }
  }
}
