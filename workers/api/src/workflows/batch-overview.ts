/**
 * BatchOverviewWorkflow — batch generation of org overviews via the Anthropic
 * Message Batches API. Follows the same three-step shape as
 * BatchSummarizeWorkflow:
 *
 *   1. collect-eligible — find orgs due for regen, hydrate per-org inputs
 *   2. submit — one batch request per eligible org (search_result blocks)
 *   3. poll-and-collect — tick the Anthropic poll loop, extract body +
 *      citations, upsert each into knowledge_pages + knowledge_page_citations
 *
 * Feature gate: the cron path (when one is wired) checks
 * `BATCH_OVERVIEW_ENABLED === "true"`. The admin POST trigger
 * (`POST /v1/workflows/batch-overview`) runs unconditionally.
 *
 * Budget guard: pre-submission cost estimate is compared against
 * `BATCH_OVERVIEW_MAX_COST_USD` (default $5). Exceeding the ceiling throws
 * `NonRetryableError` so the instance exits without retrying.
 *
 * Citations: the prompt expects releases passed as search_result blocks so the
 * model emits inline citations linking each claim back to the originating
 * release post (#846). Per-row failures in citation extraction fail soft —
 * the body still lands without citations.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { drizzle } from "drizzle-orm/d1";
import { logEvent } from "@releases/lib/log-event";
import { dbErrorLogFields } from "@releases/lib/db-errors";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { estimateCost } from "@releases/lib/anthropic-pricing.js";
import {
  MODEL,
  MAX_OUTPUT_TOKENS,
  SYSTEM_PROMPT,
  buildOverviewRequest,
  type OverviewRequestInput,
} from "@releases/ai-internal/overview-content";
import {
  extractOverviewBody,
  clampCitationsToBody,
} from "@releases/ai-internal/overview-citations";
import { submitBatch, collectResults, BATCH_ENDED_STATUS } from "@releases/ai-internal/batch";
import {
  recordBatchSubmit,
  recordBatchProgress,
  recordBatchFinalize,
  type TerminalBatchStatus,
} from "@releases/core-internal/batch-run";
import {
  fetchOverviewCandidates,
  fetchOverviewInputsForOrg,
} from "@releases/core-internal/overview-eligibility";
import { upsertOrgOverview } from "@releases/core-internal/overview-upsert";
import { getAnthropicKey, resolveGatewayOpts, type AnthropicEnv } from "../lib/anthropic.js";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BatchOverviewWorkflowEnv = AnthropicEnv & {
  DB: D1Database;
  /** Gate: when "true", the cron-triggered path is active. Admin POST always runs. */
  BATCH_OVERVIEW_ENABLED?: string;
  /** Per-run budget ceiling in USD (string, parsed to float). Default $5. */
  BATCH_OVERVIEW_MAX_COST_USD?: string;
  FLAGS?: FlagshipBinding;
};

export type BatchOverviewParams = {
  /** Min releases shipped since last overview to qualify. Default 20. */
  minNewReleases?: number;
  /** Min age of existing overview to qualify (days). Default 14. */
  minOverviewAgeDays?: number;
  /** Hard cap on orgs per run. Default 100. */
  maxCandidates?: number;
  /** Optional org slug filter. null / undefined = all eligible. */
  orgs?: string[] | null;
  /** Per-run budget override (USD). */
  maxCostUsd?: number;
  /** Epoch-millisecond timestamp set at dispatch time. */
  scheduledTime: number;
  /** Discriminator for cost-accounting context. */
  trigger: "cron" | "admin";
};

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_COST_USD = 5;

const SYSTEM_PROMPT_TOKENS_ESTIMATE = Math.ceil(SYSTEM_PROMPT.length / 3.5);

/** Max poll iterations × 60s sleep = 6h ceiling (matches batch-summarize). */
const MAX_POLL_ITERATIONS = 360;

const RETRY_SHORT: WorkflowStepConfig = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};

/**
 * Single-shot config for steps that perform billed external work. A retry
 * would re-submit the Anthropic batch and double-charge; better to fail the
 * workflow loudly than to silently double-pay.
 */
const NO_RETRY: WorkflowStepConfig = {
  retries: { limit: 0, delay: "0 seconds", backoff: "constant" },
  timeout: "2 minutes",
};

const RETRY_POLL: WorkflowStepConfig = {
  retries: { limit: 1, delay: "30 seconds", backoff: "exponential" },
  timeout: "6 hours",
};

// ── Workflow ──────────────────────────────────────────────────────────────────

/** Per-org input bundle handed from the collect step to the submit step. */
interface OrgInputBundle {
  orgId: string;
  orgSlug: string;
  request: OverviewRequestInput;
  /** First selected release's publishedAt — used for last_contributing_release_at. */
  lastContributingReleaseAt: string | null;
}

export class BatchOverviewWorkflow extends WorkflowEntrypoint<
  BatchOverviewWorkflowEnv,
  BatchOverviewParams
> {
  async run(event: WorkflowEvent<BatchOverviewParams>, step: WorkflowStep): Promise<void> {
    const env = this.env;
    const { minNewReleases, minOverviewAgeDays, maxCandidates, orgs, trigger } = event.payload;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern
    const db: any = drizzle(env.DB);

    // ── Step 1: collect-eligible ───────────────────────────────────────────

    const collectResult = await step.do(
      "collect-eligible",
      RETRY_SHORT,
      async (): Promise<{
        bundles: OrgInputBundle[];
        estCostUsd: number;
        skippedEnabled: boolean;
      }> => {
        if (
          trigger === "cron" &&
          !(await flag(env.FLAGS, env.BATCH_OVERVIEW_ENABLED, FLAGS.batchOverviewEnabled))
        ) {
          logEvent("info", {
            component: "batch-overview",
            event: "disabled",
            trigger,
          });
          return { bundles: [], estCostUsd: 0, skippedEnabled: true };
        }

        const candidates = await fetchOverviewCandidates(db, {
          minNewReleases,
          minOverviewAgeDays,
          maxCandidates,
          orgSlugs: orgs ?? null,
        });

        logEvent("info", {
          component: "batch-overview",
          event: "candidates-fetched",
          trigger,
          candidateCount: candidates.length,
        });

        // Hydrate per-org inputs sequentially. Concurrency would race D1 — a
        // workflow step is already on a single thread anyway, so parallelism
        // here doesn't speed anything up. Sequential keeps memory bounded
        // and matches the batch-summarize pattern (one D1 round-trip at a time).
        const bundles: OrgInputBundle[] = [];
        for (const c of candidates) {
          // eslint-disable-next-line no-await-in-loop -- D1 sequential by design
          const inputs = await fetchOverviewInputsForOrg(db, c.orgId);
          if (!inputs || inputs.selected.length === 0) continue;
          bundles.push({
            orgId: c.orgId,
            orgSlug: c.orgSlug,
            request: {
              org: { name: inputs.org.name, description: inputs.org.description },
              sources: inputs.sources.map((s) => ({ name: s.name })),
              selected: inputs.selected.map((r) => ({
                id: r.id,
                title: r.title,
                version: r.version,
                content: r.content ?? "",
                publishedAt: r.publishedAt,
                url: r.url,
              })),
              existingContent: inputs.existingContent,
              totalAvailable: inputs.totalAvailable,
            },
            lastContributingReleaseAt: inputs.selected[0]?.publishedAt ?? null,
          });
        }

        // Pre-submission cost estimate. Per-row input ≈ SYSTEM_PROMPT +
        // sum(content blocks). The Batches API honors cache_control so the
        // SYSTEM_PROMPT charge collapses after the first org in the batch —
        // we still include it per request for the conservative estimate.
        let totalEstInputTokens = 0;
        for (const b of bundles) {
          totalEstInputTokens += SYSTEM_PROMPT_TOKENS_ESTIMATE;
          for (const r of b.request.selected) {
            const truncated = Math.min(r.content.length, 1000);
            totalEstInputTokens += Math.ceil((truncated + 200) / 3.5); // 200 = release-meta + title
          }
          if (b.request.existingContent) {
            totalEstInputTokens += Math.ceil(b.request.existingContent.length / 3.5);
          }
        }
        const estOutputTokens = bundles.length * MAX_OUTPUT_TOKENS;
        const costEst = estimateCost(
          { inputTokens: totalEstInputTokens, outputTokens: estOutputTokens },
          MODEL,
          { batch: true },
        );
        const estCostUsd = costEst?.totalUsd ?? 0;

        const maxCostUsd =
          event.payload.maxCostUsd ??
          (() => {
            const parsed = parseFloat(env.BATCH_OVERVIEW_MAX_COST_USD ?? "");
            return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_COST_USD;
          })();

        if (estCostUsd > maxCostUsd) {
          throw new NonRetryableError(
            `budget exceeded: $${estCostUsd.toFixed(4)} > $${maxCostUsd.toFixed(2)}; ` +
              `widen maxCostUsd or narrow the org filter / thresholds`,
          );
        }

        logEvent("info", {
          component: "batch-overview",
          event: "collect-complete",
          trigger,
          candidateCount: candidates.length,
          bundleCount: bundles.length,
          estCostUsd,
          maxCostUsd,
        });

        return { bundles, estCostUsd, skippedEnabled: false };
      },
    );

    if (collectResult.skippedEnabled || collectResult.bundles.length === 0) {
      if (!collectResult.skippedEnabled) {
        logEvent("info", {
          component: "batch-overview",
          event: "no-eligible-orgs",
          trigger,
        });
      }
      return;
    }

    const { bundles, estCostUsd } = collectResult;

    // ── Step 2: submit ─────────────────────────────────────────────────────

    // Submit is split from record-submit so a transient D1 failure on the
    // recording side doesn't retry the paid Anthropic submission. submit-batch
    // is single-shot (NO_RETRY); record-submit is idempotent on
    // (anthropicBatchId) so it can safely retry.
    const anthropicBatchId = await step.do("submit-batch", NO_RETRY, async (): Promise<string> => {
      const apiKey = await getAnthropicKey(env);
      if (!apiKey) {
        throw new NonRetryableError("ANTHROPIC_API_KEY not configured");
      }

      const gatewayOpts = await resolveGatewayOpts(env);
      const client = buildAnthropicClient({ apiKey, ...gatewayOpts });

      // One batch request per org. `custom_id = orgId` so collectResults
      // can look up the bundle on the way back.
      const messageRequests = bundles.map((b) => ({
        custom_id: b.orgId,
        params: buildOverviewRequest(b.request),
      }));

      const submitted = await submitBatch(client, messageRequests);
      return submitted.id;
    });

    const batchRunId = await step.do("record-submit", RETRY_SHORT, async (): Promise<string> => {
      const id = await recordBatchSubmit(db, {
        anthropicBatchId,
        caller: "workflow",
        model: MODEL,
        estCostUsd,
        requestCountTotal: bundles.length,
        callerContext: {
          trigger,
          kind: "overview",
          orgs: orgs ?? null,
          minNewReleases,
          minOverviewAgeDays,
        },
      });

      logEvent("info", {
        component: "batch-overview",
        event: "batch-submitted",
        batchRunId: id,
        anthropicBatchId,
        requestCount: bundles.length,
        estCostUsd,
      });

      return id;
    });

    // ── Step 3: poll-and-collect ───────────────────────────────────────────

    await step.do("poll-and-collect", RETRY_POLL, async () => {
      const apiKey = await getAnthropicKey(env);
      if (!apiKey) {
        throw new NonRetryableError("ANTHROPIC_API_KEY not configured in poll step");
      }

      const gatewayOpts = await resolveGatewayOpts(env);
      const client = buildAnthropicClient({ apiKey, ...gatewayOpts });

      let finalBatch: {
        processing_status: string;
        request_counts: { succeeded: number; errored: number; expired: number; canceled: number };
      } | null = null;
      let lastCounts: {
        succeeded: number;
        errored: number;
        expired: number;
        canceled: number;
      } | null = null;
      for (let i = 0; i < MAX_POLL_ITERATIONS; i++) {
        // oxlint-disable-next-line no-await-in-loop -- intentional poll loop
        await step.sleep("between-polls", "60 seconds");

        // oxlint-disable-next-line no-await-in-loop -- poll loop
        const cur = await client.messages.batches.retrieve(anthropicBatchId);

        const rc = cur.request_counts;
        const countsChanged =
          lastCounts === null ||
          rc.succeeded !== lastCounts.succeeded ||
          rc.errored !== lastCounts.errored ||
          rc.expired !== lastCounts.expired ||
          rc.canceled !== lastCounts.canceled;
        if (countsChanged) {
          lastCounts = { ...rc };
          // oxlint-disable-next-line no-await-in-loop -- delta-guarded progress update
          await recordBatchProgress(db, anthropicBatchId, {
            succeeded: rc.succeeded,
            errored: rc.errored,
            expired: rc.expired,
            canceled: rc.canceled,
          }).catch((err) => {
            logEvent("warn", {
              component: "batch-overview",
              event: "progress-update-failed",
              batchRunId,
              anthropicBatchId,
              err,
              ...dbErrorLogFields(err),
            });
          });
        }

        if (cur.processing_status === BATCH_ENDED_STATUS) {
          finalBatch = cur;
          break;
        }

        logEvent("info", {
          component: "batch-overview",
          event: "poll-tick",
          batchRunId,
          anthropicBatchId,
          iteration: i,
          requestCounts: rc,
        });
      }

      if (!finalBatch) {
        await recordBatchFinalize(db, anthropicBatchId, {
          status: "failed",
          endedAt: new Date().toISOString(),
          counts: { succeeded: 0, errored: 0, expired: 0, canceled: 0 },
          actualCostUsd: null,
          errorSummary: { reason: "poll-timeout", maxIterations: MAX_POLL_ITERATIONS },
        }).catch(() => undefined);
        throw new NonRetryableError(
          `batch-overview: poll timed out after ${MAX_POLL_ITERATIONS} iterations for ${anthropicBatchId}`,
        );
      }

      // Index bundles by orgId so we can look up totalAvailable +
      // lastContributingReleaseAt during the upsert pass.
      const byOrg = new Map<string, OrgInputBundle>(
        bundles.map((b: OrgInputBundle) => [b.orgId, b] as const),
      );

      const outcomes = await collectResults(client, anthropicBatchId, (message, customId) => {
        // Per-outcome parse: extract body + citations. extractOverviewBody
        // HTML-entity-decodes each text block before measuring offsets (#1146 —
        // the batch model over-escapes the same way sub-agents do; the agent
        // path's fix is releases-cli #229), and clampCitationsToBody catches any
        // post-strip overhang before SQL even sees them. NB: the cron entry to
        // this workflow self-gates on BATCH_OVERVIEW_ENABLED (false in prod), so
        // today this path runs only via the admin POST / `overview batch`.
        const extraction = extractOverviewBody(message);
        const citations = clampCitationsToBody(extraction.body, extraction.citations);
        return {
          body: extraction.body,
          citations,
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

      for (const [orgId, outcome] of outcomes) {
        const bundle = byOrg.get(orgId);
        if (!bundle) {
          failed++;
          if (errorSampleIds.length < 20) errorSampleIds.push(orgId);
          continue;
        }
        if (outcome.kind !== "succeeded") {
          failed++;
          if (errorSampleIds.length < 20) errorSampleIds.push(orgId);
          logEvent("warn", {
            component: "batch-overview",
            event: "outcome-not-succeeded",
            orgId,
            orgSlug: bundle.orgSlug,
            kind: outcome.kind,
          });
          continue;
        }

        const { body, citations, usage } = outcome.value;

        // Cost is paid the moment Anthropic ran the request — count it before
        // any persistence check so empty-body / upsert-failure rows still show
        // up in actualCostUsd.
        const rowCost = estimateCost(
          {
            inputTokens: usage.input + usage.cacheRead,
            cacheWriteTokens: usage.cacheCreate,
            outputTokens: usage.output,
          },
          MODEL,
          { batch: true },
        );
        actualCostUsd += rowCost?.totalUsd ?? 0;

        if (!body.trim()) {
          failed++;
          if (errorSampleIds.length < 20) errorSampleIds.push(orgId);
          logEvent("warn", {
            component: "batch-overview",
            event: "empty-body",
            orgId,
            orgSlug: bundle.orgSlug,
          });
          continue;
        }

        try {
          // oxlint-disable-next-line no-await-in-loop -- per-org sequential upsert
          await upsertOrgOverview(db, {
            orgId,
            content: body,
            citations,
            releaseCount: bundle.request.totalAvailable,
            lastContributingReleaseAt: bundle.lastContributingReleaseAt,
          });

          succeeded++;
        } catch (err: unknown) {
          failed++;
          if (errorSampleIds.length < 20) errorSampleIds.push(orgId);
          logEvent("warn", {
            component: "batch-overview",
            event: "upsert-failed",
            orgId,
            orgSlug: bundle.orgSlug,
            err,
            ...dbErrorLogFields(err),
          });
        }
      }

      const finalStatus: TerminalBatchStatus = succeeded > 0 ? BATCH_ENDED_STATUS : "failed";
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
        actualCostUsd: actualCostUsd > 0 ? actualCostUsd : null,
        errorSummary,
      }).catch((err) => {
        logEvent("warn", {
          component: "batch-overview",
          event: "finalize-failed",
          batchRunId,
          anthropicBatchId,
          err,
          ...dbErrorLogFields(err),
        });
      });

      logEvent("info", {
        component: "batch-overview",
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

// Upsert SQL lives in `@releases/core-internal/overview-upsert` and is shared
// with `POST /v1/orgs/:slug/overview`.
