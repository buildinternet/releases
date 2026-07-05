/**
 * Per-org overview regeneration loop (AI SDK structured-output lane).
 *
 * Processes a chunk of candidate orgs sequentially: hydrates per-org inputs,
 * generates via `generateOverview`, and upserts the result. Per-org failures
 * are caught and counted so a single failing org never aborts the chunk.
 *
 * Used by the OverviewRegenWorkflow step handler. Split from the workflow so
 * it can be unit-tested independently of Cloudflare Workflows primitives.
 */

import { APICallError, type LanguageModel } from "ai";
import {
  fetchOverviewInputsForOrg,
  type OverviewCandidate,
  type OverviewInputsForOrg,
} from "@releases/core-internal/overview-eligibility";
import { upsertOrgOverview } from "@releases/core-internal/overview-upsert";
import {
  generateOverview,
  type GenerateOverviewOptions,
  type OverviewRequestInput,
} from "@releases/ai-internal/overview-content";
import type { ResolvedOverviewModel } from "../lib/text-model";
import { logEvent } from "@releases/lib/log-event";

export interface RegenChunkResult {
  generated: number;
  skipped: number;
  failed: number;
  /** Slugs of orgs that failed all attempts — surfaced in the run-done summary. */
  failedSlugs: string[];
}

/**
 * Per-org generation retry. The OpenRouter overview lane occasionally trips a
 * transient `TimeoutError` (issue #1793) that a fresh request clears — OpenRouter
 * may route the retry to a faster provider. Retry only the LLM generation (not
 * the D1 hydrate/upsert around it), and keep it distinct from the chunk-level
 * `RETRY_REGEN` step retry, which re-runs the whole 5-org chunk and would re-bill
 * orgs that already succeeded.
 */
const MAX_GEN_ATTEMPTS = 2; // initial try + one retry
const GEN_RETRY_BACKOFF_MS = 2_000;

/**
 * Only transient provider failures are worth a fresh request. A retry helps when
 * OpenRouter tripped a `TimeoutError`/abort or returned a 429/5xx (a re-issue may
 * route to a faster/healthier provider). Deterministic failures — parse or
 * lint-correction bugs, config errors — recur on retry, so those fail fast rather
 * than burning a second billed call and masking the bug behind a warn.
 */
function isRetryableOverviewError(err: unknown): boolean {
  if (err instanceof Error && err.name === "TimeoutError") return true;
  // AI SDK surfaces provider HTTP failures as APICallError; its own `isRetryable`
  // flag already classifies 429/5xx/network as transient (4xx as not).
  if (APICallError.isInstance(err)) {
    return err.isRetryable || (err.statusCode !== undefined && err.statusCode >= 500);
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("timeout") || msg.includes("aborted")) return true;
  return /openrouter (429|5\d\d)\b/.test(msg);
}

async function generateOverviewWithRetry(
  model: LanguageModel,
  input: OverviewRequestInput,
  orgSlug: string,
  genOpts: GenerateOverviewOptions,
  opts?: { maxAttempts?: number; retryBackoffMs?: number },
): ReturnType<typeof generateOverview> {
  const maxAttempts = opts?.maxAttempts ?? MAX_GEN_ATTEMPTS;
  const backoffMs = opts?.retryBackoffMs ?? GEN_RETRY_BACKOFF_MS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential retry attempts
      return await generateOverview(model, input, genOpts);
    } catch (err: unknown) {
      // Rethrow immediately on the last attempt or a non-transient error.
      if (attempt >= maxAttempts || !isRetryableOverviewError(err)) throw err;
      logEvent("warn", {
        component: "overview-regen",
        event: "org-retry",
        orgSlug,
        attempt,
        err,
      });
      if (backoffMs > 0) {
        // oxlint-disable-next-line no-await-in-loop -- deliberate inter-attempt backoff
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  // Unreachable when maxAttempts >= 1 (the loop returns or throws); guards maxAttempts=0.
  throw new Error(`overview generation exhausted ${maxAttempts} attempts`);
}

/** Map the hydrated per-org inputs to the generation request shape (selection already applied upstream). */
function toOverviewRequestInput(inputs: OverviewInputsForOrg): OverviewRequestInput {
  return {
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
  };
}

/**
 * Regenerate overviews for a chunk of candidate orgs. Sequential (D1 + one LLM
 * call per org); per-org failures are caught and counted, never aborting the
 * chunk. `dryRun` generates but does not persist.
 */
export async function regenerateOverviewChunk(
  db: Parameters<typeof upsertOrgOverview>[0],
  resolved: ResolvedOverviewModel,
  candidates: OverviewCandidate[],
  opts?: { dryRun?: boolean; maxAttempts?: number; retryBackoffMs?: number },
): Promise<RegenChunkResult> {
  let generated = 0;
  let skipped = 0;
  const failedSlugs: string[] = [];
  const genOpts: GenerateOverviewOptions = {
    timeoutMs: resolved.timeoutMs,
    onUsage: resolved.onUsage,
  };

  for (const c of candidates) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- per-org sequential: D1 + one LLM call each
      const inputs = await fetchOverviewInputsForOrg(db, c.orgId);
      if (!inputs || inputs.selected.length === 0) {
        skipped++;
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      const { body, citations, truncated } = await generateOverviewWithRetry(
        resolved.model,
        toOverviewRequestInput(inputs),
        c.orgSlug,
        genOpts,
        opts,
      );
      if (body.trim().length === 0) {
        skipped++;
        continue;
      }
      if (truncated) {
        // The kept draft hit the output cap (`finishReason: "length"`) — the tail
        // of its structured citation list was likely cut. The body is still valid,
        // so we persist it; this warning is the signal to raise the cap.
        logEvent("warn", {
          component: "overview-regen",
          event: "org-truncated",
          orgId: c.orgId,
          orgSlug: c.orgSlug,
          releaseCount: inputs.totalAvailable,
          citations: citations.length,
        });
      }
      if (opts?.dryRun) {
        generated++;
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      await upsertOrgOverview(db, {
        orgId: c.orgId,
        content: body,
        citations,
        releaseCount: inputs.totalAvailable,
        lastContributingReleaseAt: inputs.selected[0]?.publishedAt ?? null,
      });
      generated++;
    } catch (err: unknown) {
      failedSlugs.push(c.orgSlug);
      logEvent("warn", {
        component: "overview-regen",
        event: "org-failed",
        orgId: c.orgId,
        orgSlug: c.orgSlug,
        err,
      });
    }
  }
  return { generated, skipped, failed: failedSlugs.length, failedSlugs };
}
