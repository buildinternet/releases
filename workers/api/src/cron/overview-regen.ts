/**
 * Per-org overview regeneration loop (OpenRouter TextModel lane).
 *
 * Processes a chunk of candidate orgs sequentially: hydrates per-org inputs,
 * generates via `generateOverview`, and upserts the result. Per-org failures
 * are caught and counted so a single failing org never aborts the chunk.
 *
 * Used by the OverviewRegenWorkflow step handler. Split from the workflow so
 * it can be unit-tested independently of Cloudflare Workflows primitives.
 */

import {
  fetchOverviewInputsForOrg,
  type OverviewCandidate,
  type OverviewInputsForOrg,
} from "@releases/core-internal/overview-eligibility";
import { upsertOrgOverview } from "@releases/core-internal/overview-upsert";
import {
  generateOverview,
  type OverviewRequestInput,
} from "@releases/ai-internal/overview-content";
import type { TextModel } from "@releases/ai-internal/text-model";
import { logEvent } from "@releases/lib/log-event";

export interface RegenChunkResult {
  generated: number;
  skipped: number;
  failed: number;
}

/** Map the hydrated per-org inputs to the generation request shape (selection already applied upstream). */
export function toOverviewRequestInput(inputs: OverviewInputsForOrg): OverviewRequestInput {
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
  model: TextModel,
  candidates: OverviewCandidate[],
  opts?: { dryRun?: boolean },
): Promise<RegenChunkResult> {
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of candidates) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- per-org sequential: D1 + one LLM call each
      const inputs = await fetchOverviewInputsForOrg(db, c.orgId);
      if (!inputs || inputs.selected.length === 0) {
        skipped++;
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      const { body, citations } = await generateOverview(model, toOverviewRequestInput(inputs));
      if (body.trim().length === 0) {
        skipped++;
        continue;
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
      failed++;
      logEvent("warn", {
        component: "overview-regen",
        event: "org-failed",
        orgId: c.orgId,
        orgSlug: c.orgSlug,
        err,
      });
    }
  }
  return { generated, skipped, failed };
}
