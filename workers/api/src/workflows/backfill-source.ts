/**
 * Durable Cloudflare Workflow for full-history backfill of a windowed scrape
 * source. Acquires the full page body once (Firecrawl / plain fetch / supplied
 * markdown), saves it to R2 as a content-addressed snapshot, then extracts each
 * window as its own step so Cloudflare can retry or resume at the window
 * boundary on transient failure. See issue #1281.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types.js";
import { getSourceMeta, htmlToMarkdown } from "@releases/adapters/feed.js";
import { createFirecrawlClient } from "@releases/adapters/firecrawl.js";
import type { FirecrawlClient } from "@releases/adapters/firecrawl.js";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { logEvent } from "@releases/lib/log-event";
import { getSecret } from "@releases/lib/secrets";
import { getAnthropicKey, resolveGatewayOpts } from "../lib/anthropic.js";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { planWindowOffsets } from "../lib/firecrawl-extract.js";
import {
  sliceChangelog,
  DEFAULT_CHANGELOG_SLICE_TOKENS,
} from "@buildinternet/releases-core/changelog-slice";
import {
  extractFromBody,
  mapEntries,
  CLOUDFLARE_SYSTEM_PROMPT,
  type ExtractDeps,
} from "@releases/adapters/extract";
import { saveRawSnapshot, loadRawSnapshot } from "../lib/raw-snapshot.js";
import { ingestRawReleases, embedReleasesForSource, type FetchOneEnv } from "../cron/poll-fetch.js";
import {
  RETRY_POLL,
  RETRY_FETCH,
  resolveFetchEnv,
  generateContentForReleases,
  type PollAndFetchWorkflowEnv,
} from "./poll-and-fetch.js";
import {
  effectiveBackfillWindows,
  firecrawlCapGuidance,
  dedupeByUrl,
  dateRange,
  type BackfillBodyVia,
  type SourceBackfillReport,
} from "../lib/source-backfill.js";

// Haiku at temperature 0 — cheap + deterministic for structured extraction.
const BACKFILL_EXTRACT_MODEL = "claude-haiku-4-5-20251001";

// Per-batch summary chunk — mirrors BACKFILL_SUMMARY_CHUNK in workflows.ts.
// generateContentForReleases bails above MAX_AUTOGEN_ROWS_PER_FIRE (20) in
// poll-and-fetch; chunk under it so a large backfill still regenerates every row.
const BACKFILL_SUMMARY_CHUNK = 20;

const backfillLogger = {
  info: (msg: string) =>
    logEvent("info", {
      component: "backfill-source-workflow",
      event: "extract-info",
      message: msg,
    }),
  warn: (msg: string) =>
    logEvent("warn", {
      component: "backfill-source-workflow",
      event: "extract-warn",
      message: msg,
    }),
  debug: (msg: string) =>
    logEvent("info", {
      component: "backfill-source-workflow",
      event: "extract-debug",
      message: msg,
    }),
  error: (msg: string) =>
    logEvent("error", {
      component: "backfill-source-workflow",
      event: "extract-error",
      message: msg,
    }),
};

export interface BackfillSourceParams {
  /** Source row id to backfill. */
  sourceId: string;
  /** Max extraction windows (clamped to FIRECRAWL_BACKFILL_MAX_WINDOWS on the firecrawl path). */
  maxWindows: number;
  /** When true, plan + extract but skip the DB upsert. */
  dryRun: boolean;
  /** Pre-acquired markdown body. Bypasses Firecrawl / plain-fetch acquisition. */
  suppliedMarkdown?: string;
}

export type BackfillSourceEnv = PollAndFetchWorkflowEnv & {
  RAW_SNAPSHOTS?: R2Bucket;
  FIRECRAWL_API_KEY?: { get(): Promise<string> };
  /** TEST-ONLY: inject a pre-built FirecrawlClient. */
  _firecrawlClientOverride?: FirecrawlClient;
  /** TEST-ONLY: inject per-window extraction (skips Anthropic). */
  _extractOverride?: (markdown: string, source: Source) => Promise<RawRelease[]>;
};

/** Window-level result stored in step state (never the full body). */
interface WindowStepResult {
  extracted: number;
  deduped: number;
  insertedIds: string[];
  found: number;
  inserted: number;
  entries: Array<{ url: string | undefined; publishedAt: string | undefined }>;
}

export class BackfillSourceWorkflow extends WorkflowEntrypoint<
  BackfillSourceEnv,
  BackfillSourceParams
> {
  async run(
    event: WorkflowEvent<BackfillSourceParams>,
    step: WorkflowStep,
  ): Promise<SourceBackfillReport> {
    const env = this.env;
    const { sourceId, maxWindows, dryRun, suppliedMarkdown } = event.payload;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern; same as poll-and-fetch
    const db: any = env._drizzleOverride ?? drizzle(env.DB);

    // ── Step 1: load-source ─────────────────────────────────────────────────
    const source = await step.do("load-source", RETRY_POLL, async () => {
      const [row]: Source[] = await db.select().from(sources).where(eq(sources.id, sourceId));
      if (!row) throw new NonRetryableError(`source ${sourceId} not found`);
      if (row.type !== "scrape") {
        throw new NonRetryableError(
          `backfill supports scrape sources only; source ${sourceId} has type=${row.type}`,
        );
      }
      return row;
    });

    // ── Step 2: resolve-and-save-raw ────────────────────────────────────────
    // Acquire the body ONCE, save to R2 (content-addressed, dedup-safe), and
    // return only the small pointer object — never pass the full body through
    // step state, which has size limits and makes replay expensive.
    const { r2Key, via } = await step.do("resolve-and-save-raw", RETRY_FETCH, async () => {
      // Saving the raw body to R2 is intrinsic to this durable path: every
      // window step re-loads from R2 so the (large) body never lands in
      // Cloudflare step state. Prod binds `released-raw`, staging reuses
      // `released-media`, tests inject a fake — so the binding is always
      // present in any real path. Bail loudly if it isn't.
      if (!env.RAW_SNAPSHOTS) {
        throw new NonRetryableError("RAW_SNAPSHOTS binding is required for BackfillSourceWorkflow");
      }

      let body: string;
      let resolvedVia: BackfillBodyVia;

      if (suppliedMarkdown?.trim()) {
        body = suppliedMarkdown;
        resolvedVia = "supplied";
      } else {
        const meta = getSourceMeta(source);
        if (meta.firecrawl?.enabled) {
          let client: FirecrawlClient;
          if (env._firecrawlClientOverride) {
            client = env._firecrawlClientOverride;
          } else {
            const apiKey = await getSecret(env.FIRECRAWL_API_KEY);
            if (!apiKey) throw new NonRetryableError("FIRECRAWL_API_KEY is not configured");
            client = createFirecrawlClient({ apiKey });
          }
          const md = await client.scrapeOnce(source.url, { proxy: meta.firecrawl?.proxy });
          if (!md) throw new Error(`empty Firecrawl scrape for ${source.url}`);
          body = md;
          resolvedVia = "firecrawl";
        } else {
          const res = await fetch(source.url, { headers: { "User-Agent": RELEASES_BOT_UA } });
          const md = res.ok ? htmlToMarkdown(await res.text()) : "";
          if (!md.trim()) {
            throw new NonRetryableError(
              `could not fetch a usable body for ${source.url}; supply markdown or enable Firecrawl`,
            );
          }
          body = md;
          resolvedVia = "fetch";
        }
      }

      // Save to R2 (content-addressed, dedup-safe) and return ONLY the small
      // pointer — never the full body through step state.
      const snap = await saveRawSnapshot(
        { R2: env.RAW_SNAPSHOTS, db },
        { sourceId, body, format: "markdown" },
      );
      return { r2Key: snap.r2Key, via: resolvedVia };
    });

    // ── Step 3: plan-windows ────────────────────────────────────────────────
    // Load raw body from R2 (always present — r2Key is non-null past step 2),
    // then compute the per-window offsets without any LLM calls.
    const { offsets, cappedAtWindow, droppedChars } = await step.do(
      "plan-windows",
      RETRY_POLL,
      async () => {
        const raw = await loadRawSnapshot({ R2: env.RAW_SNAPSHOTS! }, r2Key);
        // Null here is a transient R2 read blip — throw a plain (retryable) Error.
        if (!raw) throw new Error(`R2 snapshot missing for key ${r2Key}`);
        const effectiveMax = effectiveBackfillWindows(via, maxWindows);
        return planWindowOffsets(raw, { maxWindows: effectiveMax });
      },
    );

    // ── Steps 4+: extract-window-N ──────────────────────────────────────────
    // Each window is its own step.do so Cloudflare can retry or resume at the
    // window boundary. Results are collected for aggregation in the final step.
    const windowResults: WindowStepResult[] = [];
    for (let i = 0; i < offsets.length; i++) {
      const offset = offsets[i];
      // oxlint-disable-next-line no-await-in-loop -- sequential by design; per-window step.do boundary is the point
      const windowResult = await step.do(
        `extract-window-${i}`,
        RETRY_FETCH,
        async (): Promise<WindowStepResult> => {
          // Load raw body from R2 (idempotent; r2Key is always present here).
          // Null is a transient R2 read blip — throw a plain (retryable) Error.
          const raw = await loadRawSnapshot({ R2: env.RAW_SNAPSHOTS! }, r2Key);
          if (!raw) throw new Error(`R2 snapshot missing for key ${r2Key}`);

          const sliced = sliceChangelog(raw, { tokens: DEFAULT_CHANGELOG_SLICE_TOKENS, offset });

          let entries: RawRelease[];
          if (env._extractOverride) {
            entries = await env._extractOverride(sliced.content, source);
          } else {
            const apiKey = await getAnthropicKey(env);
            if (!apiKey) throw new NonRetryableError("ANTHROPIC_API_KEY is not configured");
            const anthropicClient = buildAnthropicClient({
              apiKey,
              ...(await resolveGatewayOpts(env)),
            });
            const extractDeps: ExtractDeps = {
              anthropicClient,
              agentModel: BACKFILL_EXTRACT_MODEL,
              logger: backfillLogger,
              cloudflare: null,
              extractToolLoopEnabled: false,
              repo: {
                peekContentHash: async () => false,
                commitContentHash: async () => {},
                updateSourceMeta: async () => {},
                getOrgPlaybook: async () => null,
                logUsage: async () => {},
              },
            };
            const result = await extractFromBody(
              {
                body: sliced.content,
                systemPrompt: CLOUDFLARE_SYSTEM_PROMPT,
                userMessage: `Extract all changelog/release entries from this page (source URL: ${source.url}):`,
                sourceUrl: source.url,
                fetchUrl: source.url,
              },
              extractDeps,
            );
            entries = mapEntries(result.entries, { sourceUrl: source.url }) as RawRelease[];
          }

          const deduped = dedupeByUrl(entries);

          if (dryRun) {
            return {
              extracted: entries.length,
              deduped: deduped.length,
              insertedIds: [],
              found: 0,
              inserted: 0,
              entries: deduped.map((e) => ({
                url: e.url ?? undefined,
                publishedAt: e.publishedAt?.toISOString(),
              })),
            };
          }

          const fetchEnv: FetchOneEnv = await resolveFetchEnv(env);
          const ingest = await ingestRawReleases(db, source, deduped, fetchEnv);
          return {
            extracted: entries.length,
            deduped: deduped.length,
            insertedIds: ingest.insertedIds,
            found: ingest.found,
            inserted: ingest.inserted,
            entries: deduped.map((e) => ({
              url: e.url ?? undefined,
              publishedAt: e.publishedAt?.toISOString(),
            })),
          };
        },
      );
      windowResults.push(windowResult);
    }

    // ── Step 5: finalize ─────────────────────────────────────────────────────
    // Aggregate counts, compute date range, embed + generate content for new rows.
    const report = await step.do("finalize", RETRY_POLL, async () => {
      const allExtracted = windowResults.reduce((n, r) => n + r.extracted, 0);
      const allDeduped = windowResults.reduce((n, r) => n + r.deduped, 0);
      const allFound = windowResults.reduce((n, r) => n + r.found, 0);
      const allInserted = windowResults.reduce((n, r) => n + r.inserted, 0);
      const allInsertedIds = windowResults.flatMap((r) => r.insertedIds);

      // Compute date range from all per-window entries
      const allEntries = windowResults.flatMap((r) =>
        r.entries.map((e) => ({
          publishedAt: e.publishedAt ? new Date(e.publishedAt) : undefined,
        })),
      );
      const dr = dateRange(
        allEntries.map((e) => ({ publishedAt: e.publishedAt ?? null }) as RawRelease),
      );

      const guidance = firecrawlCapGuidance({
        via,
        cappedAtWindow,
        effectiveMaxWindows: effectiveBackfillWindows(via, maxWindows),
        requestedMaxWindows: maxWindows,
      });

      const result: SourceBackfillReport = {
        source: { id: source.id, slug: source.slug },
        via,
        windows: offsets.length,
        cappedAtWindow,
        droppedChars,
        extracted: allExtracted,
        deduped: allDeduped,
        dateRange: dr,
        found: allFound,
        inserted: allInserted,
        dryRun,
        ...(guidance ? { guidance } : {}),
      };

      if (!dryRun && allInsertedIds.length > 0) {
        if (env.RELEASES_INDEX) {
          await embedReleasesForSource(db, source, allInsertedIds, await resolveFetchEnv(env), {
            throwOnError: false,
          });
        }
        for (let i = 0; i < allInsertedIds.length; i += BACKFILL_SUMMARY_CHUNK) {
          // oxlint-disable-next-line no-await-in-loop -- bounded chunks under the autogen row cap
          await generateContentForReleases(
            db,
            env,
            source,
            allInsertedIds.slice(i, i + BACKFILL_SUMMARY_CHUNK),
          );
        }
      }

      return result;
    });

    logEvent("info", {
      component: "backfill-source-workflow",
      event: "completed",
      sourceId,
      via,
      windows: offsets.length,
      extracted: report.extracted,
      inserted: report.inserted,
      dryRun,
    });

    return report;
  }
}
