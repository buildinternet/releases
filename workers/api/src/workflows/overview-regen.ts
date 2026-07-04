/**
 * OverviewRegenWorkflow — OpenRouter-backed per-org overview regeneration.
 *
 * Collects due orgs via `fetchOverviewCandidates`, chunks them into groups of
 * CHUNK_SIZE, and regenerates each chunk in a retriable `step.do()`. The
 * inner `regenerateOverviewChunk` is unit-tested independently (see
 * workers/api/src/cron/overview-regen.test.ts).
 *
 * Eligibility is staleness-gated (minNewReleases:0): an overview stale ≥7d with
 * ≥1 new release, or a missing overview — matching the local update-overviews
 * skill, so the weekly sweep actually fires at normal release volumes.
 *
 * Feature gate: cron-triggered path (when wired) checks
 * `OVERVIEW_REGEN_ENABLED === "true"` via the Flagship/var fallback.
 * Admin POST trigger (`POST /v1/workflows/overview-regen`) runs unconditionally.
 *
 * Model resolution: `resolveOverviewModel` returns an OpenRouter TextModel when
 * OPENROUTER_API_KEY + SUMMARIZE_MODEL are configured (shared summary lane, tagged
 * `org-overview`); falls back to a direct Anthropic Haiku call otherwise; null when
 * neither is available → NonRetryableError (no point retrying a config problem).
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  fetchOverviewCandidates,
  type OverviewCandidate,
} from "@releases/core-internal/overview-eligibility";
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js";
import { resolveOverviewModel } from "../lib/text-model.js";
import { regenerateOverviewChunk, type RegenChunkResult } from "../cron/overview-regen.js";
import type { TextModelEnv } from "../lib/text-model.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type OverviewRegenParams = {
  scheduledTime: number;
  trigger: "cron" | "admin";
  orgs?: string[] | null;
  dryRun?: boolean;
  maxOrgs?: number;
};

export type OverviewRegenWorkflowEnv = TextModelEnv & {
  DB: D1Database;
  FLAGS?: FlagshipBinding;
  OVERVIEW_REGEN_ENABLED?: string;
  /** Velocity fast-tier tunables (#1895); unset → eligibility defaults (2d at ≥15). */
  OVERVIEW_FAST_CADENCE_DAYS?: string;
  OVERVIEW_FAST_MIN_RELEASES?: string;
};

/** Parse a positive-integer wrangler var; undefined (→ eligibility default) otherwise. */
function positiveIntVar(value: string | undefined): number | undefined {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 5;

const RETRY_COLLECT: WorkflowStepConfig = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};

// A chunk of CHUNK_SIZE orgs runs sequentially; the step timeout must cover the
// pathological single-attempt cost so a slow chunk finishes rather than tripping
// the (billed) chunk-level retry. Per org, worst case: a first attempt that times
// out (~60s, the org-overview lane ceiling) + backoff (~2s) + a retry that then
// succeeds slowly, including generateOverview's corrective second pass (~60s+60s)
// ≈ 182s. Across CHUNK_SIZE=5 that is ~15.2 min, so 20 min keeps clear headroom.
const RETRY_REGEN: WorkflowStepConfig = {
  retries: { limit: 1, delay: "30 seconds", backoff: "exponential" },
  timeout: "20 minutes",
};

// ── Workflow ──────────────────────────────────────────────────────────────────

export class OverviewRegenWorkflow extends WorkflowEntrypoint<
  OverviewRegenWorkflowEnv,
  OverviewRegenParams
> {
  async run(event: WorkflowEvent<OverviewRegenParams>, step: WorkflowStep): Promise<void> {
    const { trigger, orgs, dryRun, maxOrgs } = event.payload;

    const candidates = await step.do(
      "collect",
      RETRY_COLLECT,
      async (): Promise<OverviewCandidate[]> => {
        if (
          trigger === "cron" &&
          !(await flag(this.env.FLAGS, this.env.OVERVIEW_REGEN_ENABLED, FLAGS.overviewRegenEnabled))
        ) {
          logEvent("info", {
            component: "overview-regen",
            event: "disabled",
            trigger,
          });
          return [];
        }

        const db = createDb(this.env.DB);
        return fetchOverviewCandidates(db, {
          orgSlugs: orgs ?? null,
          // Staleness-gated, not volume-gated. minNewReleases:0 makes the
          // eligibility "overview stale (≥ the org's cadence, default 7d /
          // 2d fast tier / per-org override) AND ≥1 new release, OR missing"
          // — the same selection the local update-overviews skill uses
          // (`--stale-days 7 --missing --has-activity`). The default 20 would
          // leave the sweep dormant at normal release volumes.
          // (batch-overview keeps the 20.)
          minNewReleases: 0,
          // Velocity fast-tier tunables (#1895): wrangler-var overrides; unset
          // falls back to the eligibility defaults (2 days at ≥15 releases).
          fastCadenceDays: positiveIntVar(this.env.OVERVIEW_FAST_CADENCE_DAYS),
          fastMinReleases: positiveIntVar(this.env.OVERVIEW_FAST_MIN_RELEASES),
          ...(typeof maxOrgs === "number" && maxOrgs > 0 ? { maxCandidates: maxOrgs } : {}),
        });
      },
    );

    logEvent("info", {
      component: "overview-regen",
      event: "candidates-fetched",
      trigger,
      candidateCount: candidates.length,
    });

    if (candidates.length === 0) {
      logEvent("info", {
        component: "overview-regen",
        event: "run-done",
        trigger,
        eligible: 0,
        generated: 0,
        skipped: 0,
        failed: 0,
        failedSlugs: [],
      });
      return;
    }

    const totals: RegenChunkResult = {
      generated: 0,
      skipped: 0,
      failed: 0,
      failedSlugs: [],
    };
    const chunkCount = Math.ceil(candidates.length / CHUNK_SIZE);

    for (let i = 0; i < chunkCount; i++) {
      const slice = candidates.slice(i * CHUNK_SIZE, i * CHUNK_SIZE + CHUNK_SIZE);
      // oxlint-disable-next-line no-await-in-loop -- sequential durable steps; bound D1/LLM load
      const r = await step.do(
        `regen-chunk-${i}`,
        RETRY_REGEN,
        async (): Promise<RegenChunkResult> => {
          const db = createDb(this.env.DB);
          const model = await resolveOverviewModel(this.env);
          if (!model) {
            throw new NonRetryableError(
              "no overview model available (no OpenRouter key and no Anthropic fallback)",
            );
          }
          return regenerateOverviewChunk(db, model, slice, { dryRun });
        },
      );
      totals.generated += r.generated;
      totals.skipped += r.skipped;
      totals.failed += r.failed;
      totals.failedSlugs.push(...r.failedSlugs);
    }

    logEvent(totals.failed > 0 ? "warn" : "info", {
      component: "overview-regen",
      event: "run-done",
      trigger,
      eligible: candidates.length,
      ...totals,
    });
  }
}
