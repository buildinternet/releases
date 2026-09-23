/**
 * Map a marketing-classifier attempt onto the Analytics Engine point input.
 * Choice and reason are slugs only — title, content, URL, and provider errors
 * never land on the point.
 */
import type { MarketingClassifierResult } from "@releases/ai-internal/marketing-classifier";
import {
  MARKETING_POLICY_VERSION,
  MARKETING_SUPPRESSION_THRESHOLD,
  type ClassificationDisposition,
  type ClassificationOrigin,
  type ClassificationPointInput,
} from "./classification-schema.js";

export interface MarketingClassificationRecord {
  index: number;
  disposition: ClassificationDisposition;
  /** `classify_error`, `cap_tripped`, or `no_provider`. Empty on kept/suppressed. */
  failureCategory: string | null;
  verdict: MarketingClassifierResult | null;
  /** Empty when the attempt never resolved a model. The encoder writes `unknown`. */
  provider: string | null;
  model: string | null;
  /** Set only when a classify call was actually timed. */
  durationMs: number | null;
}

export function marketingClassificationInput(
  record: Omit<MarketingClassificationRecord, "index">,
  ctx: {
    origin: ClassificationOrigin;
    releaseId?: string | null;
    sourceId?: string | null;
    /** Effective threshold used for this attempt. Falls back to the code
     *  default when omitted (callers should always pass the resolved value). */
    threshold?: number | null;
  },
): ClassificationPointInput {
  const scored = record.disposition === "kept" || record.disposition === "suppressed";
  const verdict = scored ? record.verdict : null;
  const decision = verdict?.decision;
  let choice = "";
  if (verdict) {
    if (decision) choice = decision.choice;
    else if (verdict.isMarketing) choice = verdict.reason;
    else choice = "not_marketing";
  }
  return {
    origin: ctx.origin,
    classificationType: "marketing",
    releaseId: ctx.releaseId,
    sourceId: ctx.sourceId,
    provider: record.provider,
    model: record.model,
    choice,
    disposition: record.disposition,
    reason: verdict?.reason ?? "",
    policyVersion: MARKETING_POLICY_VERSION,
    failureCategory: scored ? null : record.failureCategory,
    selectedChoiceProbability: decision?.selectedChoiceProbability ?? null,
    providerConfidence: decision?.providerConfidence ?? null,
    threshold: ctx.threshold ?? MARKETING_SUPPRESSION_THRESHOLD,
    costUsd: verdict ? (verdict.usage.costUsd ?? null) : null,
    inputTokens: verdict ? verdict.usage.input : null,
    outputTokens: verdict ? verdict.usage.output : null,
    durationMs: record.durationMs,
  };
}

/**
 * Keep records whose pre-assigned id came back from INSERT … RETURNING.
 * Suppressed ids are included. Conflict ids (`onConflictDoNothing`) are not.
 */
export function pointsForInserted(
  records: readonly MarketingClassificationRecord[],
  idByIndex: ReadonlyMap<number, string>,
  returnedIds: ReadonlySet<string>,
): Array<MarketingClassificationRecord & { releaseId: string }> {
  const out: Array<MarketingClassificationRecord & { releaseId: string }> = [];
  for (const record of records) {
    const releaseId = idByIndex.get(record.index);
    if (!releaseId || !returnedIds.has(releaseId)) continue;
    out.push({ ...record, releaseId });
  }
  return out;
}
