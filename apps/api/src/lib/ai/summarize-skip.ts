/**
 * Structured pre-model skip signal for the `summarize-release` lane.
 *
 * Axiom's "inserts with no summarization" monitor used to treat a missing
 * `ai_usage` / `summarize-release` event as "summarization didn't run". Empty
 * bodies, oversized bodies, and eligibility gates skip before any model call,
 * so that absence is expected. This event is the positive signal: one row per
 * reason per call, with a stable `reason` code and a `count` APL can sum
 * without inferring skips from missing usage events.
 *
 * `batch-summary` (`skippedEmpty` / `skippedTooLarge`) stays as-is for the
 * loop that already emits it. Gates that return before that loop (hidden,
 * opted-out, source opt-out, coverage, row cap) only show up here.
 */

import { logEvent } from "@releases/lib/log-event";

/** `ai_usage.lane` for release summarization. Skip events use the same string. */
export const SUMMARIZE_RELEASE_LANE = "summarize-release";

/**
 * Stable reason codes. Add a code when a new pre-model gate appears; do not
 * rename existing ones — APL filters on these strings.
 *
 * - `empty` — `isEmptyContent` (no model call)
 * - `too-large` — body over the per-row char cap
 * - `opted-out` — org `autoGenerateContent` is false (and the caller is not ignoring that gate)
 * - `source-opt-out` — `metadata.summarize === false`
 * - `hidden` — source `isHidden`
 * - `coverage` — coverage-side row (hidden from read paths)
 * - `row-cap` — eligible candidate count over the per-fire cap (the whole batch is skipped)
 * - `missing` — inserted id was not in the database
 * - `ineligible` — failed the eligibility SELECT for a reason the probe didn't name
 */
export const SUMMARIZE_SKIP_REASONS = [
  "empty",
  "too-large",
  "opted-out",
  "source-opt-out",
  "hidden",
  "coverage",
  "row-cap",
  "missing",
  "ineligible",
] as const;

export type SummarizeSkipReason = (typeof SUMMARIZE_SKIP_REASONS)[number];

/** Cap on `releaseIds` so a backfill skip can't blow up a log line. `count` stays exact. */
export const SUMMARIZE_SKIP_ID_LIMIT = 20;

export type SummarizeSkipComponent = "auto-generate-content" | "batch-summarize";

/**
 * Emit one `summarize-skip` event. No-op when `releaseIds` is empty so a quiet
 * fire doesn't write a zero-count row.
 */
export function logSummarizeSkip(args: {
  component: SummarizeSkipComponent;
  reason: SummarizeSkipReason;
  releaseIds: readonly string[];
  sourceSlug?: string;
}): void {
  if (args.releaseIds.length === 0) return;
  logEvent("info", {
    component: args.component,
    event: "summarize-skip",
    lane: SUMMARIZE_RELEASE_LANE,
    reason: args.reason,
    count: args.releaseIds.length,
    releaseIds: args.releaseIds.slice(0, SUMMARIZE_SKIP_ID_LIMIT),
    releaseIdsTruncated: args.releaseIds.length > SUMMARIZE_SKIP_ID_LIMIT,
    ...(args.sourceSlug ? { sourceSlug: args.sourceSlug } : {}),
  });
}

/** Emit one event per reason that has ids, in stable reason-code order. */
export function logSummarizeSkips(
  component: SummarizeSkipComponent,
  sourceSlug: string | undefined,
  byReason: ReadonlyMap<SummarizeSkipReason, readonly string[]>,
): void {
  for (const reason of SUMMARIZE_SKIP_REASONS) {
    const ids = byReason.get(reason);
    if (ids && ids.length > 0) {
      logSummarizeSkip({ component, reason, releaseIds: ids, sourceSlug });
    }
  }
}
