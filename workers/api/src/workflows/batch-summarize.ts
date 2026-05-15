/**
 * BatchSummarizeWorkflow — daily batch content generation for releases missing
 * `title_generated` / `title_short` / `summary`, using the Anthropic Message
 * Batches API (50% cost reduction vs. real-time). See issue #971.
 *
 * Three step.do boundaries, following the same conventions as PollAndFetchWorkflow:
 *
 *   1. collect-eligible — query D1 for eligible releases and estimate cost
 *   2. submit — call submitBatch, record the batch_run row
 *   3. poll-and-collect — tick the Anthropic poll loop, upsert results to D1
 *
 * Feature gate: the cron path checks `BATCH_SUMMARIZE_ENABLED === "true"` before
 * doing any work. The admin POST trigger (`POST /v1/workflows/batch-summarize`)
 * runs unconditionally (caller is making a deliberate one-off decision).
 *
 * Budget guard: estimated cost (pre-submission) is compared against
 * `BATCH_SUMMARIZE_MAX_COST_USD` (default $10). Exceeding the ceiling throws
 * `NonRetryableError` so the instance exits without retrying.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import { releases } from "@buildinternet/releases-core/schema";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { logEvent } from "@releases/lib/log-event";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { estimateCost } from "@releases/lib/anthropic-pricing.js";
import {
  MODEL,
  MAX_OUTPUT_TOKENS,
  SYSTEM_PROMPT,
  buildReleaseBlock,
  parseReleaseContent,
  isEmptyContent,
} from "@releases/ai-internal/release-content";
import { submitBatch, collectResults } from "@releases/ai-internal/batch";
import {
  recordBatchSubmit,
  recordBatchProgress,
  recordBatchFinalize,
} from "@releases/core-internal/batch-run";
import { fetchEligibleReleases } from "@releases/core-internal/eligibility";
import { getAnthropicKey, resolveGatewayOpts, type AnthropicEnv } from "../lib/anthropic.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BatchSummarizeWorkflowEnv = AnthropicEnv & {
  DB: D1Database;
  /** Gate: when "true", the cron-triggered path is active. Admin POST always runs. */
  BATCH_SUMMARIZE_ENABLED?: string;
  /**
   * Per-run budget ceiling in USD (string, parsed to float). Default $10.
   * If the estimated cost exceeds this, the workflow aborts with NonRetryableError.
   */
  BATCH_SUMMARIZE_MAX_COST_USD?: string;
};

export type BatchSummarizeParams = {
  /** Cutoff in days. Default 1 (catches up the past 24h). */
  sinceDays?: number;
  /** Optional org slug filter. null / undefined = all opted-in orgs. */
  orgs?: string[] | null;
  /**
   * Per-run budget override (USD). Overrides BATCH_SUMMARIZE_MAX_COST_USD when
   * provided (via admin POST body).
   */
  maxCostUsd?: number;
  /**
   * Epoch-millisecond timestamp set at dispatch time. Used to distinguish cron-
   * triggered fires (from the `scheduled()` handler) from admin POST triggers
   * so the gate check knows whether to enforce BATCH_SUMMARIZE_ENABLED.
   */
  scheduledTime: number;
  /**
   * Discriminator for cost-accounting context. Set by the caller.
   * "cron" | "admin"
   */
  trigger: "cron" | "admin";
};

// ── Constants ─────────────────────────────────────────────────────────────────

/** Per-row body cap — matches `MAX_AUTOGEN_BODY_CHARS` in poll-and-fetch.ts. */
const MAX_BODY_CHARS = 50_000;

/** Default budget ceiling before any API calls. */
const DEFAULT_MAX_COST_USD = 10;

/** Hard cap on eligible rows per run (defence against runaway selects). */
const MAX_ELIGIBLE_ROWS = 2_000;

/**
 * Tokens per row for cost estimation: SYSTEM_PROMPT chars / 4 + per-row block.
 * We estimate 3.5 chars/token as a conservative approximation (Haiku 4.5 uses
 * ~4 chars/token on average; code-heavy content runs lower). The SYSTEM_PROMPT
 * is sent once per batch request — there is no batch-level caching in the
 * Batches API, so we count it for every request in the estimate.
 */
const SYSTEM_PROMPT_TOKENS_ESTIMATE = Math.ceil(SYSTEM_PROMPT.length / 3.5);

/**
 * Max poll iterations before giving up. Each iteration sleeps 60 seconds first.
 * 360 iterations × 60s = 6h upper bound, matching Cloudflare Workflow step
 * timeout for the poll-and-collect step.
 */
const MAX_POLL_ITERATIONS = 360;

// ── Retry policies ────────────────────────────────────────────────────────────

const RETRY_COLLECT: WorkflowStepConfig = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};

const RETRY_SUBMIT: WorkflowStepConfig = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};

const RETRY_POLL: WorkflowStepConfig = {
  retries: { limit: 1, delay: "30 seconds", backoff: "exponential" },
  // Anthropic batches can take up to 24h; give the poll step a 6h ceiling.
  timeout: "6 hours",
};

// ── Workflow ──────────────────────────────────────────────────────────────────

export class BatchSummarizeWorkflow extends WorkflowEntrypoint<
  BatchSummarizeWorkflowEnv,
  BatchSummarizeParams
> {
  async run(event: WorkflowEvent<BatchSummarizeParams>, step: WorkflowStep): Promise<void> {
    const env = this.env;
    const { sinceDays = 1, orgs, trigger } = event.payload;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern
    const db: any = drizzle(env.DB);

    // ── Step 1: collect-eligible ───────────────────────────────────────────

    const collectResult = await step.do(
      "collect-eligible",
      RETRY_COLLECT,
      async (): Promise<{
        rows: Array<{
          id: string;
          title: string;
          version: string | null;
          content: string;
          url: string | null;
          orgSlug: string;
          sourceName: string;
          productName: string | null;
        }>;
        estCostUsd: number;
        eligibleCount: number;
        skippedEnabled: boolean;
      }> => {
        // Feature gate: cron fires check the env var; admin POST is always on.
        if (trigger === "cron" && env.BATCH_SUMMARIZE_ENABLED !== "true") {
          logEvent("info", {
            component: "batch-summarize",
            event: "disabled",
            trigger,
          });
          return { rows: [], estCostUsd: 0, eligibleCount: 0, skippedEnabled: true };
        }

        const cutoffIso = daysAgoIso(sinceDays);
        const eligible = await fetchEligibleReleases(db, {
          cutoffIso,
          orgSlugs: orgs ?? null,
          maxRows: MAX_ELIGIBLE_ROWS,
        });

        // Filter out empty-content and over-size rows locally (no API call).
        const rows = eligible.filter((row) => {
          if (!row.content || isEmptyContent(row.content)) return false;
          if (row.content.length > MAX_BODY_CHARS) return false;
          return true;
        });

        // Estimate cost without any API calls. Each request carries the full
        // SYSTEM_PROMPT (no cross-request cache in the Batches API) plus a
        // per-row user message. We estimate token counts from character counts
        // and apply the 50% batch discount.
        let totalEstInputTokens = 0;
        for (const row of rows) {
          const releaseBlock = buildReleaseBlock({
            orgSlug: row.orgSlug,
            sourceName: row.sourceName,
            productName: row.productName,
            title: row.title,
            version: row.version,
            url: row.url,
            content: row.content,
          });
          totalEstInputTokens += SYSTEM_PROMPT_TOKENS_ESTIMATE;
          totalEstInputTokens += Math.ceil(releaseBlock.length / 3.5);
        }

        const estOutputTokens = rows.length * MAX_OUTPUT_TOKENS;
        const costEst = estimateCost(
          { inputTokens: totalEstInputTokens, outputTokens: estOutputTokens },
          MODEL,
          { batch: true },
        );
        const estCostUsd = costEst?.totalUsd ?? 0;

        // Budget guard — resolve ceiling from params override or env var.
        const maxCostUsd =
          event.payload.maxCostUsd ??
          (() => {
            const parsed = parseFloat(env.BATCH_SUMMARIZE_MAX_COST_USD ?? "");
            return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_COST_USD;
          })();

        if (estCostUsd > maxCostUsd) {
          throw new NonRetryableError(
            `budget exceeded: $${estCostUsd.toFixed(4)} > $${maxCostUsd.toFixed(2)}; ` +
              `widen maxCostUsd or narrow the org/time filter`,
          );
        }

        logEvent("info", {
          component: "batch-summarize",
          event: "collect-complete",
          trigger,
          sinceDays,
          eligibleCount: eligible.length,
          filteredCount: rows.length,
          estCostUsd,
          maxCostUsd,
        });

        return { rows, estCostUsd, eligibleCount: eligible.length, skippedEnabled: false };
      },
    );

    // Cron gate short-circuits or no rows → done.
    if (collectResult.skippedEnabled || collectResult.rows.length === 0) {
      if (!collectResult.skippedEnabled) {
        logEvent("info", {
          component: "batch-summarize",
          event: "no-eligible-rows",
          trigger,
          sinceDays,
        });
      }
      return;
    }

    const { rows, estCostUsd } = collectResult;

    // ── Step 2: submit ─────────────────────────────────────────────────────

    const submitResult = await step.do(
      "submit",
      RETRY_SUBMIT,
      async (): Promise<{ batchRunId: string; anthropicBatchId: string }> => {
        const apiKey = await getAnthropicKey(env);
        if (!apiKey) {
          throw new NonRetryableError("ANTHROPIC_API_KEY not configured");
        }

        const gatewayOpts = await resolveGatewayOpts(env);
        const client = buildAnthropicClient({ apiKey, ...gatewayOpts });

        // Build one request per eligible row.
        const messageRequests = rows.map((row) => ({
          custom_id: row.id,
          params: {
            model: MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: [
              {
                type: "text" as const,
                text: SYSTEM_PROMPT,
                cache_control: { type: "ephemeral" as const },
              },
            ],
            messages: [
              {
                role: "user" as const,
                content: buildReleaseBlock({
                  orgSlug: row.orgSlug,
                  sourceName: row.sourceName,
                  productName: row.productName,
                  title: row.title,
                  version: row.version,
                  url: row.url,
                  content: row.content,
                }),
              },
            ],
          },
        }));

        const submitted = await submitBatch(client, messageRequests);

        const batchRunId = await recordBatchSubmit(db, {
          anthropicBatchId: submitted.id,
          caller: "workflow",
          model: MODEL,
          estCostUsd,
          requestCountTotal: rows.length,
          callerContext: {
            trigger,
            sinceDays,
            orgs: orgs ?? null,
          },
        });

        logEvent("info", {
          component: "batch-summarize",
          event: "batch-submitted",
          batchRunId,
          anthropicBatchId: submitted.id,
          requestCount: rows.length,
          estCostUsd,
        });

        return { batchRunId, anthropicBatchId: submitted.id };
      },
    );

    const { batchRunId, anthropicBatchId } = submitResult;

    // ── Step 3: poll-and-collect ───────────────────────────────────────────

    await step.do("poll-and-collect", RETRY_POLL, async () => {
      const apiKey = await getAnthropicKey(env);
      if (!apiKey) {
        throw new NonRetryableError("ANTHROPIC_API_KEY not configured in poll step");
      }

      const gatewayOpts = await resolveGatewayOpts(env);
      const client = buildAnthropicClient({ apiKey, ...gatewayOpts });

      // Manual poll loop: step.sleep between each retrieve so we don't nest
      // pollBatch's own loop inside a workflow step (nested polling loops
      // fight each other for the step boundary).
      let finalBatch: {
        processing_status: string;
        request_counts: { succeeded: number; errored: number; expired: number; canceled: number };
      } | null = null;
      for (let i = 0; i < MAX_POLL_ITERATIONS; i++) {
        // Always sleep first — Anthropic batches take minutes minimum.
        // oxlint-disable-next-line no-await-in-loop -- intentional poll loop inside a workflow step
        await step.sleep("between-polls", "60 seconds");

        // oxlint-disable-next-line no-await-in-loop -- poll loop
        const cur = await client.messages.batches.retrieve(anthropicBatchId);

        // Best-effort progress update; don't let a DB write failure abort the loop.
        // oxlint-disable-next-line no-await-in-loop -- sequential update
        await recordBatchProgress(db, anthropicBatchId, {
          succeeded: cur.request_counts.succeeded,
          errored: cur.request_counts.errored,
          expired: cur.request_counts.expired,
          canceled: cur.request_counts.canceled,
        }).catch((err) => {
          logEvent("warn", {
            component: "batch-summarize",
            event: "progress-update-failed",
            batchRunId,
            anthropicBatchId,
            err,
          });
        });

        if (cur.processing_status === "ended") {
          finalBatch = cur;
          break;
        }

        logEvent("info", {
          component: "batch-summarize",
          event: "poll-tick",
          batchRunId,
          anthropicBatchId,
          iteration: i,
          requestCounts: cur.request_counts,
        });
      }

      if (!finalBatch) {
        // Exhausted MAX_POLL_ITERATIONS without ending. Record as failed.
        await recordBatchFinalize(db, anthropicBatchId, {
          status: "failed",
          endedAt: new Date().toISOString(),
          counts: { succeeded: 0, errored: 0, expired: 0, canceled: 0 },
          actualCostUsd: null,
          errorSummary: { reason: "poll-timeout", maxIterations: MAX_POLL_ITERATIONS },
        }).catch(() => undefined);
        throw new Error(
          `batch-summarize: poll timed out after ${MAX_POLL_ITERATIONS} iterations for ${anthropicBatchId}`,
        );
      }

      // Collect results and upsert into releases.
      const outcomes = await collectResults(client, anthropicBatchId, (message, customId) => {
        const raw = message.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        return {
          parsed: parseReleaseContent(raw, message.stop_reason),
          usage: {
            input: message.usage.input_tokens,
            output: message.usage.output_tokens,
            cacheCreate: message.usage.cache_creation_input_tokens ?? 0,
            cacheRead: message.usage.cache_read_input_tokens ?? 0,
          },
          customId,
        };
      });

      let succeeded = 0;
      let failed = 0;
      let actualCostUsd = 0;
      const errorSampleIds: string[] = [];

      for (const [customId, outcome] of outcomes) {
        if (outcome.kind === "succeeded") {
          const { parsed, usage } = outcome.value;
          // Idempotent: only write when title_short is still NULL so a step
          // retry doesn't overwrite a row that succeeded on a prior attempt.
          // oxlint-disable-next-line no-await-in-loop -- per-row UPDATE inside collect loop
          await db
            .update(releases)
            .set({
              titleGenerated: parsed.title,
              titleShort: parsed.titleShort,
              summary: parsed.summary,
            })
            .where(and(eq(releases.id, customId), sql`${releases.titleShort} IS NULL`))
            .catch((err: unknown) => {
              logEvent("warn", {
                component: "batch-summarize",
                event: "upsert-failed",
                releaseId: customId,
                err,
              });
            });

          // Accumulate actual cost from per-request usage.
          const rowCost = estimateCost(
            {
              inputTokens: usage.input + usage.cacheRead,
              cacheWriteTokens: usage.cacheCreate,
              outputTokens: usage.output,
            },
            MODEL,
            { batch: true },
          );
          if (rowCost) actualCostUsd += rowCost.totalUsd;
          succeeded++;
        } else {
          failed++;
          if (errorSampleIds.length < 20) errorSampleIds.push(customId);
          logEvent("warn", {
            component: "batch-summarize",
            event: "outcome-not-succeeded",
            releaseId: customId,
            kind: outcome.kind,
          });
        }
      }

      const finalStatus = succeeded > 0 ? "ended" : "failed";
      const errorSummary =
        failed > 0
          ? {
              failedCount: failed,
              sampleIds: errorSampleIds,
            }
          : null;

      await recordBatchFinalize(db, anthropicBatchId, {
        status: finalStatus,
        endedAt: new Date().toISOString(),
        counts: {
          succeeded: finalBatch.request_counts.succeeded,
          errored: finalBatch.request_counts.errored,
          expired: finalBatch.request_counts.expired,
          canceled: finalBatch.request_counts.canceled,
        },
        actualCostUsd: succeeded > 0 ? actualCostUsd : null,
        errorSummary,
      }).catch((err) => {
        logEvent("warn", {
          component: "batch-summarize",
          event: "finalize-failed",
          batchRunId,
          anthropicBatchId,
          err,
        });
      });

      logEvent("info", {
        component: "batch-summarize",
        event: "done",
        batchRunId,
        anthropicBatchId,
        succeeded,
        failed,
        actualCostUsd,
        finalStatus,
      });
    });
  }
}
