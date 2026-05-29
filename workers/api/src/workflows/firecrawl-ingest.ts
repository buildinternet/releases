/**
 * Workflow triggered when Firecrawl detects a change on a monitored source
 * (inbound webhook → POST /v1/sources/:slug/firecrawl/ingest). Re-scrapes the
 * page via Firecrawl, extracts releases, inserts them through the standard
 * ingest tail (dedup → coverage → publish → IndexNow), then embeds and
 * optionally summarizes the new rows. See Phase 2 of the Firecrawl monitoring
 * integration plan.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { sources, fetchLog } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/feed.js";
import { createFirecrawlClient } from "@releases/adapters/firecrawl.js";
import type { FirecrawlClient } from "@releases/adapters/firecrawl.js";
import type { RawRelease } from "@releases/adapters/types.js";
import { logEvent } from "@releases/lib/log-event";
import { getSecret } from "@releases/lib/secrets";
import { getAnthropicKey, resolveGatewayOpts } from "../lib/anthropic.js";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { extractFirecrawlMarkdown } from "../lib/firecrawl-extract.js";
import { ingestRawReleases, embedReleasesForSource, type FetchOneEnv } from "../cron/poll-fetch.js";
import {
  resolveFetchEnv,
  generateContentForReleases,
  type PollAndFetchWorkflowEnv,
} from "./poll-and-fetch.js";

// Agent model for Firecrawl extraction. Matches DEFAULT_AGENT_MODEL in the
// discovery worker so extraction quality is consistent across ingest paths.
const FIRECRAWL_EXTRACT_MODEL = "claude-sonnet-4-6";

/**
 * Retry policies — mirrors the values in poll-and-fetch.ts; module-private
 * there so we define our own here with the same values.
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

const RETRY_GENERATE = {
  retries: { limit: 1, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
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
}

export type FirecrawlIngestEnv = PollAndFetchWorkflowEnv & {
  FIRECRAWL_API_KEY?: { get(): Promise<string> };
  /** TEST-ONLY: inject a pre-built FirecrawlClient instead of constructing one. */
  _firecrawlClientOverride?: FirecrawlClient;
  /** TEST-ONLY: inject an extraction function instead of calling the LLM. */
  _extractOverride?: (markdown: string, source: Source) => Promise<RawRelease[]>;
};

export class FirecrawlIngestWorkflow extends WorkflowEntrypoint<
  FirecrawlIngestEnv,
  FirecrawlIngestParams
> {
  async run(event: WorkflowEvent<FirecrawlIngestParams>, step: WorkflowStep): Promise<void> {
    const env = this.env;
    const { sourceId, url, checkId, status } = event.payload;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern; same as poll-and-fetch
    const db: any = env._drizzleOverride ?? drizzle(env.DB);

    // ── Step 1: load-source ─────────────────────────────────────────────────
    const source = await step.do("load-source", RETRY_POLL, async () => {
      const [row]: Source[] = await db.select().from(sources).where(eq(sources.id, sourceId));
      if (!row) throw new NonRetryableError(`source ${sourceId} not found`);
      const meta = getSourceMeta(row);
      if (!meta.firecrawl?.enabled) {
        throw new NonRetryableError(
          `source ${sourceId} does not have firecrawl.enabled — refusing ingest`,
        );
      }
      return row;
    });

    // ── Step 2: scrape ──────────────────────────────────────────────────────
    const markdown = await step.do("scrape", RETRY_FETCH, async () => {
      const client: FirecrawlClient = env._firecrawlClientOverride
        ? env._firecrawlClientOverride
        : await (async () => {
            const apiKey = await getSecret(env.FIRECRAWL_API_KEY);
            if (!apiKey) throw new NonRetryableError("FIRECRAWL_API_KEY is not configured");
            return createFirecrawlClient({ apiKey });
          })();
      const sourceMeta = getSourceMeta(source);
      const md = await client.scrapeOnce(url, { proxy: sourceMeta.firecrawl?.proxy });
      if (!md) throw new Error(`empty scrape result for ${url}`);
      return md;
    });

    // ── Step 3: extract ─────────────────────────────────────────────────────
    const rawReleases = await step.do("extract", RETRY_FETCH, async () => {
      if (env._extractOverride) {
        return env._extractOverride(markdown, source);
      }
      const apiKey = await getAnthropicKey(env);
      if (!apiKey) throw new NonRetryableError("ANTHROPIC_API_KEY is not configured");
      const anthropicClient = buildAnthropicClient({ apiKey, ...(await resolveGatewayOpts(env)) });
      const result = await extractFirecrawlMarkdown(markdown, source, {
        anthropicClient,
        agentModel: FIRECRAWL_EXTRACT_MODEL,
        logger: workerLogger,
      });
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

    // ── Steps 5a/5b: embed + summarize (only when new rows landed) ────────────
    if (ingest.insertedIds.length > 0) {
      if (env.RELEASES_INDEX) {
        await step.do("embed-releases", RETRY_EMBED, async () => {
          const fetchEnv: FetchOneEnv = await resolveFetchEnv(env);
          await embedReleasesForSource(db, source, ingest.insertedIds, fetchEnv, {
            throwOnError: true,
          });
        });
      }

      await step.do("generate-content", RETRY_GENERATE, async () => {
        await generateContentForReleases(db, env, source, ingest.insertedIds);
      });
    }

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
  }
}
