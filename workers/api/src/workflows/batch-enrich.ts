/**
 * BatchEnrichWorkflow — async, batched backfill of feed-content enrichment for
 * the render-heavy / JS-shell summary-only sources that the synchronous backfill
 * route (`POST /v1/workflows/enrich-feed-content`) can't finish before a client
 * disconnect. See issue #1296.
 *
 * Two costs, two solutions (the whole point of this workflow):
 *
 *   1. FETCH — Cloudflare Browser Rendering is ~15-20s/row and is NOT batchable.
 *      Each candidate page is fetched in its own durable `step.do`, saved to R2
 *      (so the body never rides through step state), mirroring
 *      BackfillSourceWorkflow. A failure resumes at the item boundary.
 *   2. EXTRACT — every `extractArticle` prompt goes into ONE Anthropic Message
 *      Batch (~50% cheaper, async ≤24h), mirroring BatchSummarizeWorkflow's
 *      submit → poll-with-step.sleep → apply shape with `batch_runs` tracking.
 *
 * On completion the parsed `<article>` bodies are applied idempotently via the
 * same `applyExtractedContent` the sync route shares, regenerated per source,
 * and the per-source enrichment circuit breaker is reset for sources that
 * actually enriched (so the forward cron path resumes).
 *
 * Trigger: admin POST only (`POST /v1/workflows/batch-enrich`) — runs
 * unconditionally, like BatchOverviewWorkflow. `BATCH_ENRICH_ENABLED` is defined
 * for a future cron path but not enforced here. Backfill-only by design; the
 * steady-state forward path stays synchronous (latency-sensitive).
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type Anthropic from "@anthropic-ai/sdk";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/source-meta.js";
import { fetchCloudflareMarkdown } from "@releases/adapters/cloudflare";
import { DEFAULT_FEED_THIN_CHARS } from "@releases/adapters/feed-depth";
import { logEvent } from "@releases/lib/log-event";
import { dbErrorLogFields } from "@releases/lib/db-errors";
import { getSecret } from "@releases/lib/secrets";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { estimateCost } from "@releases/lib/anthropic-pricing.js";
import {
  parseArticleResponse,
  MODEL as ARTICLE_MODEL,
  MAX_OUTPUT_TOKENS,
  MAX_INPUT_CHARS,
  SYSTEM_PROMPT,
} from "@releases/ai-internal/article-extract";
import { submitBatch, collectResults, BATCH_ENDED_STATUS } from "@releases/ai-internal/batch";
import {
  recordBatchSubmit,
  recordBatchProgress,
  recordBatchFinalize,
} from "@releases/core-internal/batch-run";
import type { FlagshipBinding } from "@releases/lib/flags";
import { getAnthropicKey, resolveGatewayOpts } from "../lib/anthropic.js";
import { logUsage } from "../lib/usage-log.js";
import { parsePositiveInt } from "../cron/feed-enrich.js";
import {
  selectEnrichCandidates,
  buildEnrichBatchRequests,
  applyExtractedContent,
  type EnrichCandidateRow,
} from "../lib/enrich-apply.js";
import { saveRawSnapshot, loadRawSnapshot } from "../lib/raw-snapshot.js";
import { generateContentForReleases, type PollAndFetchWorkflowEnv } from "./poll-and-fetch.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type BatchEnrichWorkflowEnv = PollAndFetchWorkflowEnv & {
  /** Content-addressed raw-body bucket (prod: released-raw; staging: released-media). */
  RAW_SNAPSHOTS?: R2Bucket;
  /** Defined for a future cron path; the admin POST trigger runs unconditionally. */
  BATCH_ENRICH_ENABLED?: string;
  /** Per-run budget ceiling in USD (string, parsed to float). Default $10. */
  BATCH_ENRICH_MAX_COST_USD?: string;
  FLAGS?: FlagshipBinding;
  /** TEST-ONLY: inject rendered markdown per URL (skips Browser Rendering). */
  _renderOverride?: (url: string) => Promise<string | null>;
  /** TEST-ONLY: inject a prepared Anthropic client (skips real Batches calls). */
  _anthropicClientOverride?: Anthropic;
};

export type BatchEnrichParams = {
  /** Sources to drain. Kept small (the deferred render-heavy set). */
  sourceIds: string[];
  /** Max candidate rows across all sources (1 fetch step each). Default 100. */
  limit?: number;
  /** Plan + report candidates without fetching, submitting, or writing. */
  dryRun?: boolean;
  /** Per-run budget override (USD); falls back to BATCH_ENRICH_MAX_COST_USD / $10. */
  maxCostUsd?: number;
};

export interface BatchEnrichReport {
  sourceIds: string[];
  scanned: number;
  fetched: number;
  enriched: number;
  skipped: number;
  dryRun: boolean;
  estCostUsd: number;
  anthropicBatchId: string | null;
}

/** Result of one per-item fetch step (the body itself lives in R2). */
interface FetchStepResult {
  releaseId: string;
  title: string;
  r2Key: string | null;
  ok: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 100;
/** Bounds the per-item fetch step count well under Cloudflare's per-instance cap. */
const MAX_LIMIT = 500;
const DEFAULT_MAX_COST_USD = 10;
/** Chunk under generateContentForReleases' MAX_AUTOGEN_ROWS_PER_FIRE (20). */
const REGEN_CHUNK = 20;
/** 360 × 60s sleep = 6h ceiling, matching the poll step timeout. */
const MAX_POLL_ITERATIONS = 360;

const SYSTEM_PROMPT_TOKENS = Math.ceil(SYSTEM_PROMPT.length / 3.5);
/**
 * Conservative worst-case per-item token estimate for the budget guard.
 * `buildArticleInput` hard-caps page markdown at MAX_INPUT_CHARS, so input is
 * bounded; output is capped at MAX_OUTPUT_TOKENS. Real cost is far lower (most
 * articles are a fraction of the cap) — the over-estimate is the right side of a
 * guard.
 */
const EST_INPUT_TOKENS_PER_ITEM = SYSTEM_PROMPT_TOKENS + Math.ceil(MAX_INPUT_CHARS / 3.5);
const EST_OUTPUT_TOKENS_PER_ITEM = MAX_OUTPUT_TOKENS;

// ── Retry policies ────────────────────────────────────────────────────────────

const RETRY_SHORT: WorkflowStepConfig = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};

/** Browser Rendering is slow; give each fetch room and a few retries. */
const RETRY_FETCH: WorkflowStepConfig = {
  retries: { limit: 2, delay: "20 seconds", backoff: "exponential" },
  timeout: "3 minutes",
};

const RETRY_POLL: WorkflowStepConfig = {
  retries: { limit: 1, delay: "30 seconds", backoff: "exponential" },
  timeout: "6 hours",
};

// ── Workflow ──────────────────────────────────────────────────────────────────

export class BatchEnrichWorkflow extends WorkflowEntrypoint<
  BatchEnrichWorkflowEnv,
  BatchEnrichParams
> {
  async run(
    event: WorkflowEvent<BatchEnrichParams>,
    step: WorkflowStep,
  ): Promise<BatchEnrichReport> {
    const env = this.env;
    const sourceIds = event.payload.sourceIds ?? [];
    const dryRun = event.payload.dryRun === true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern
    const db: any = env._drizzleOverride ?? drizzle(env.DB);

    const thinChars = parsePositiveInt(env.FEED_THIN_CHARS, DEFAULT_FEED_THIN_CHARS);
    const rawLimit = event.payload.limit ?? DEFAULT_LIMIT;
    const limit = Math.min(Math.max(Math.floor(rawLimit), 1), MAX_LIMIT);

    // ── Step 1: collect-candidates ─────────────────────────────────────────
    const { candidates, estCostUsd } = await step.do(
      "collect-candidates",
      RETRY_SHORT,
      async (): Promise<{ candidates: EnrichCandidateRow[]; estCostUsd: number }> => {
        if (sourceIds.length === 0) return { candidates: [], estCostUsd: 0 };

        const rows = await selectEnrichCandidates(db, { sourceIds, limit, thinChars });

        const costEst = estimateCost(
          {
            inputTokens: rows.length * EST_INPUT_TOKENS_PER_ITEM,
            outputTokens: rows.length * EST_OUTPUT_TOKENS_PER_ITEM,
          },
          ARTICLE_MODEL,
          { batch: true },
        );
        const est = costEst?.totalUsd ?? 0;

        const maxCostUsd =
          event.payload.maxCostUsd ??
          (() => {
            const parsed = parseFloat(env.BATCH_ENRICH_MAX_COST_USD ?? "");
            return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_COST_USD;
          })();

        if (est > maxCostUsd) {
          throw new NonRetryableError(
            `budget exceeded: $${est.toFixed(4)} > $${maxCostUsd.toFixed(2)}; ` +
              `lower limit, narrow sourceIds, or raise maxCostUsd`,
          );
        }

        logEvent("info", {
          component: "batch-enrich",
          event: "collect-complete",
          sourceIds,
          scanned: rows.length,
          estCostUsd: est,
          maxCostUsd,
          dryRun,
        });
        return { candidates: rows, estCostUsd: est };
      },
    );

    const baseReport: BatchEnrichReport = {
      sourceIds,
      scanned: candidates.length,
      fetched: 0,
      enriched: 0,
      skipped: 0,
      dryRun,
      estCostUsd,
      anthropicBatchId: null,
    };

    // Dry run or nothing to do → report and stop (no fetch / batch spend).
    if (dryRun || candidates.length === 0) {
      logEvent("info", { component: "batch-enrich", event: "done", ...baseReport });
      return baseReport;
    }

    if (!env.RAW_SNAPSHOTS) {
      throw new NonRetryableError("RAW_SNAPSHOTS binding is required for BatchEnrichWorkflow");
    }

    // ── Steps 2+: fetch each page (durable per-item, body → R2) ─────────────
    const fetchResults: FetchStepResult[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      // oxlint-disable-next-line no-await-in-loop -- per-item step.do boundary is the durability point
      const res = await step.do(`fetch-${i}`, RETRY_FETCH, async (): Promise<FetchStepResult> => {
        if (!cand.url) return { releaseId: cand.id, title: cand.title, r2Key: null, ok: false };

        const renderFn = await resolveRenderFn(env);
        if (!renderFn) {
          throw new NonRetryableError(
            "Browser Rendering creds (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN) are required",
          );
        }

        const md = await renderFn(cand.url);
        if (!md || !md.trim()) {
          logEvent("warn", {
            component: "batch-enrich",
            event: "render-empty",
            releaseId: cand.id,
            url: cand.url,
          });
          return { releaseId: cand.id, title: cand.title, r2Key: null, ok: false };
        }

        const snap = await saveRawSnapshot(
          { R2: env.RAW_SNAPSHOTS!, db },
          { sourceId: cand.sourceId, body: md, format: "markdown" },
        );
        return { releaseId: cand.id, title: cand.title, r2Key: snap.r2Key, ok: true };
      });
      fetchResults.push(res);
    }

    const okItems = fetchResults.filter((r) => r.ok && r.r2Key);

    // ── Step: submit-batch ──────────────────────────────────────────────────
    const submitResult = await step.do(
      "submit-batch",
      RETRY_SHORT,
      async (): Promise<{ anthropicBatchId: string } | null> => {
        if (okItems.length === 0) return null;

        const items = [];
        for (const item of okItems) {
          // oxlint-disable-next-line no-await-in-loop -- bounded by candidate limit
          const markdown = await loadRawSnapshot({ R2: env.RAW_SNAPSHOTS! }, item.r2Key!);
          if (!markdown) continue; // transient R2 miss — drop this item, others proceed
          items.push({ releaseId: item.releaseId, title: item.title, markdown });
        }
        if (items.length === 0) return null;

        const client = await resolveAnthropicClient(env);
        const submitted = await submitBatch(client, buildEnrichBatchRequests(items));

        await recordBatchSubmit(db, {
          anthropicBatchId: submitted.id,
          caller: "workflow",
          model: ARTICLE_MODEL,
          estCostUsd,
          requestCountTotal: items.length,
          callerContext: { sourceIds, kind: "enrich-extract" },
        });

        logEvent("info", {
          component: "batch-enrich",
          event: "batch-submitted",
          anthropicBatchId: submitted.id,
          requestCount: items.length,
          estCostUsd,
        });
        return { anthropicBatchId: submitted.id };
      },
    );

    // ── Step: poll-and-apply ──────────────────────────────────────────────────
    const report = await step.do(
      "poll-and-apply",
      RETRY_POLL,
      async (): Promise<BatchEnrichReport> => {
        const extracted = new Map<string, string>();
        const sourceOf = new Map(candidates.map((c) => [c.id, c.sourceId]));
        // Per-source token tally from the batch's succeeded messages → usage_log.
        const usageBySource = new Map<
          string,
          { input: number; output: number; cacheRead: number; cacheCreate: number; count: number }
        >();
        let finalCounts = { succeeded: 0, errored: 0, expired: 0, canceled: 0 };

        if (submitResult) {
          const { anthropicBatchId } = submitResult;
          const client = await resolveAnthropicClient(env);

          let ended = false;
          let lastCounts: typeof finalCounts | null = null;
          for (let i = 0; i < MAX_POLL_ITERATIONS; i++) {
            // oxlint-disable-next-line no-await-in-loop -- intentional poll loop inside a workflow step
            await step.sleep("between-polls", "60 seconds");
            // oxlint-disable-next-line no-await-in-loop -- poll loop
            const cur = await client.messages.batches.retrieve(anthropicBatchId);
            const rc = cur.request_counts;
            const changed =
              !lastCounts ||
              rc.succeeded !== lastCounts.succeeded ||
              rc.errored !== lastCounts.errored ||
              rc.expired !== lastCounts.expired ||
              rc.canceled !== lastCounts.canceled;
            if (changed) {
              lastCounts = {
                succeeded: rc.succeeded,
                errored: rc.errored,
                expired: rc.expired,
                canceled: rc.canceled,
              };
              // oxlint-disable-next-line no-await-in-loop -- delta-guarded progress write
              await recordBatchProgress(db, anthropicBatchId, lastCounts).catch((err) => {
                logEvent("warn", {
                  component: "batch-enrich",
                  event: "progress-update-failed",
                  anthropicBatchId,
                  err,
                  ...dbErrorLogFields(err),
                });
              });
            }
            if (cur.processing_status === BATCH_ENDED_STATUS) {
              ended = true;
              finalCounts = {
                succeeded: rc.succeeded,
                errored: rc.errored,
                expired: rc.expired,
                canceled: rc.canceled,
              };
              break;
            }
          }

          if (!ended) {
            await recordBatchFinalize(db, anthropicBatchId, {
              status: "failed",
              endedAt: new Date().toISOString(),
              counts: { succeeded: 0, errored: 0, expired: 0, canceled: 0 },
              actualCostUsd: null,
              errorSummary: { reason: "poll-timeout", maxIterations: MAX_POLL_ITERATIONS },
            }).catch(() => undefined);
            throw new NonRetryableError(
              `batch-enrich: poll timed out after ${MAX_POLL_ITERATIONS} iterations for ${anthropicBatchId}`,
            );
          }

          const outcomes = await collectResults(client, anthropicBatchId, (message) => {
            const text = message.content
              .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
              .map((b) => b.text)
              .join("");
            return {
              content: parseArticleResponse(text),
              usage: {
                input: message.usage.input_tokens,
                output: message.usage.output_tokens,
                cacheRead: message.usage.cache_read_input_tokens ?? 0,
                cacheCreate: message.usage.cache_creation_input_tokens ?? 0,
              },
            };
          });
          for (const [releaseId, outcome] of outcomes) {
            if (outcome.kind !== "succeeded") continue;
            extracted.set(releaseId, outcome.value.content);
            // Tally token usage per owning source for usage_log + actual cost.
            const sid = sourceOf.get(releaseId);
            if (!sid) continue;
            const u = usageBySource.get(sid) ?? {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheCreate: 0,
              count: 0,
            };
            u.input += outcome.value.usage.input;
            u.output += outcome.value.usage.output;
            u.cacheRead += outcome.value.usage.cacheRead;
            u.cacheCreate += outcome.value.usage.cacheCreate;
            u.count += 1;
            usageBySource.set(sid, u);
          }
        }

        // Apply (idempotent UPDATEs) — the same path the sync route uses.
        const applied = await applyExtractedContent(db, {
          candidates,
          extracted,
          thinChars,
          via: "render",
        });

        // Regenerate summary/title per source, and reset the enrichment circuit
        // breaker for sources that actually enriched (forward cron resumes).
        const enrichedBySource = groupBySource(candidates, applied.enrichedIds);
        for (const [sourceId, ids] of enrichedBySource) {
          // oxlint-disable-next-line no-await-in-loop -- per-source, bounded by sourceIds.length
          const [src]: Source[] = await db.select().from(sources).where(eq(sources.id, sourceId));
          if (!src) continue;
          for (let off = 0; off < ids.length; off += REGEN_CHUNK) {
            // oxlint-disable-next-line no-await-in-loop -- chunked under the autogen row cap
            await generateContentForReleases(db, env, src, ids.slice(off, off + REGEN_CHUNK));
          }
          // oxlint-disable-next-line no-await-in-loop -- per-source breaker reset
          await resetEnrichmentBreaker(db, src).catch((err) => {
            logEvent("warn", {
              component: "batch-enrich",
              event: "breaker-reset-failed",
              sourceId,
              err,
              ...dbErrorLogFields(err),
            });
          });
        }

        // Record per-source token usage (operation enrich-extract) and sum the
        // actual batch-discounted cost. Fail-open: a usage_log write must not
        // abort the workflow step (Cloudflare would retry the whole 6h poll).
        let actualCostUsd = 0;
        for (const [sourceId, u] of usageBySource) {
          const cost = estimateCost(
            {
              inputTokens: u.input + u.cacheRead,
              cacheWriteTokens: u.cacheCreate,
              outputTokens: u.output,
            },
            ARTICLE_MODEL,
            { batch: true },
          );
          actualCostUsd += cost?.totalUsd ?? 0;
          // oxlint-disable-next-line no-await-in-loop -- per-source, bounded by sourceIds.length
          await logUsage(
            db,
            {
              operation: "enrich-extract",
              model: ARTICLE_MODEL,
              inputTokens: u.input,
              outputTokens: u.output,
              cacheReadTokens: u.cacheRead,
              cacheWriteTokens: u.cacheCreate,
              sourceId,
              releaseCount: u.count,
            },
            "batch-enrich",
          ).catch((err) => {
            logEvent("warn", {
              component: "batch-enrich",
              event: "usage-log-failed",
              sourceId,
              err,
              ...dbErrorLogFields(err),
            });
          });
        }

        if (submitResult) {
          await recordBatchFinalize(db, submitResult.anthropicBatchId, {
            status: applied.enriched > 0 ? BATCH_ENDED_STATUS : "failed",
            endedAt: new Date().toISOString(),
            counts: finalCounts,
            actualCostUsd: actualCostUsd > 0 ? actualCostUsd : null,
            errorSummary:
              applied.skipped > 0 ? { skipped: applied.skipped, enriched: applied.enriched } : null,
          }).catch((err) => {
            logEvent("warn", {
              component: "batch-enrich",
              event: "finalize-failed",
              anthropicBatchId: submitResult.anthropicBatchId,
              err,
              ...dbErrorLogFields(err),
            });
          });
        }

        return {
          ...baseReport,
          fetched: okItems.length,
          enriched: applied.enriched,
          skipped: applied.skipped,
          anthropicBatchId: submitResult?.anthropicBatchId ?? null,
        };
      },
    );

    logEvent("info", { component: "batch-enrich", event: "done", ...report });
    return report;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build the Browser-Rendering markdown fetcher, or null when creds are absent. */
async function resolveRenderFn(
  env: BatchEnrichWorkflowEnv,
): Promise<((url: string) => Promise<string | null>) | null> {
  if (env._renderOverride) return env._renderOverride;
  const accountId = await getSecret(env.CLOUDFLARE_ACCOUNT_ID).catch(() => null);
  const apiToken = await getSecret(env.CLOUDFLARE_API_TOKEN).catch(() => null);
  if (!accountId || !apiToken) return null;
  return (url: string) => fetchCloudflareMarkdown(url, accountId, apiToken);
}

async function resolveAnthropicClient(env: BatchEnrichWorkflowEnv): Promise<Anthropic> {
  if (env._anthropicClientOverride) return env._anthropicClientOverride;
  const apiKey = await getAnthropicKey(env);
  if (!apiKey) throw new NonRetryableError("ANTHROPIC_API_KEY not configured");
  return buildAnthropicClient({ apiKey, ...(await resolveGatewayOpts(env)) });
}

/** Group enriched release ids by their owning source, preserving candidate order. */
function groupBySource(
  candidates: ReadonlyArray<EnrichCandidateRow>,
  enrichedIds: ReadonlyArray<string>,
): Map<string, string[]> {
  const sourceOf = new Map(candidates.map((c) => [c.id, c.sourceId]));
  const out = new Map<string, string[]>();
  for (const id of enrichedIds) {
    const sourceId = sourceOf.get(id);
    if (!sourceId) continue;
    const list = out.get(sourceId) ?? [];
    list.push(id);
    out.set(sourceId, list);
  }
  return out;
}

/**
 * Reset the per-source enrichment circuit breaker (`metadata.enrichment
 * .consecutiveFailures`) to 0 after a successful backfill, merging against the
 * freshly-read row so a concurrent metadata edit isn't clobbered.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern
async function resetEnrichmentBreaker(db: any, src: Source): Promise<void> {
  const meta = getSourceMeta(src);
  if ((meta.enrichment?.consecutiveFailures ?? 0) === 0) return;
  const merged = { ...meta, enrichment: { ...meta.enrichment, consecutiveFailures: 0 } };
  await db
    .update(sources)
    .set({ metadata: JSON.stringify(merged) })
    .where(eq(sources.id, src.id));
}
