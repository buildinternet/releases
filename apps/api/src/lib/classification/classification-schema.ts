/**
 * Workers Analytics Engine point schema for marketing classification.
 *
 * Positional and append-only. Queries pin these indexes; do not reorder.
 *
 *   index1: source id, or `none` when the attempt has no source
 *   blob1:  schema version
 *   blob2:  environment (`production` | `staging` | `development`)
 *   blob3:  origin (`ingest` | `manual` | `eval`)
 *   blob4:  classification type (`marketing`)
 *   blob5:  release id, or empty when the row was not inserted
 *   blob6:  source id (duplicate of the index; empty when index1 is `none`)
 *   blob7:  provider
 *   blob8:  model
 *   blob9:  choice
 *   blob10: disposition (`kept` | `suppressed` | `failed` | `skipped`)
 *   blob11: reason slug
 *   blob12: policy version
 *   blob13: failure or skip category (never a raw provider error)
 *   double1: selected-choice probability, or -1 when absent
 *   double2: provider confidence, or -1 when absent
 *   double3: suppression threshold
 *   double4: cost USD, or -1 when absent
 *   double5: input tokens, or -1 when absent
 *   double6: output tokens, or -1 when absent
 *   double7: duration milliseconds, or -1 when absent
 *   double8: event count (always 1)
 *
 * Free-form input (title, content, URL, raw errors, tokens) is dropped.
 * Analytics Engine keeps points for about three months and may sample.
 */
import {
  MARKETING_POLICY_VERSION,
  MARKETING_SUPPRESSION_THRESHOLD,
} from "@releases/ai-internal/marketing-classifier";
import { logEvent } from "@releases/lib/log-event";

export { MARKETING_POLICY_VERSION, MARKETING_SUPPRESSION_THRESHOLD };

export const CLASSIFICATION_SCHEMA_VERSION = "1";
export const ABSENT_DOUBLE = -1;
export const NO_SOURCE_INDEX = "none";
export const DATASET_PRODUCTION = "release_classifications";
export const DATASET_STAGING = "release_classifications_staging";
export const CLASSIFICATION_RETENTION_DAYS = 90;

export const CLASSIFICATION_ORIGINS = ["ingest", "manual", "eval"] as const;
export const CLASSIFICATION_DISPOSITIONS = ["kept", "suppressed", "failed", "skipped"] as const;
export const CLASSIFICATION_TYPES = ["marketing"] as const;
export const CLASSIFICATION_BUCKETS = ["hour", "day"] as const;

export type ClassificationOrigin = (typeof CLASSIFICATION_ORIGINS)[number];
export type ClassificationDisposition = (typeof CLASSIFICATION_DISPOSITIONS)[number];
export type ClassificationType = (typeof CLASSIFICATION_TYPES)[number];
export type ClassificationBucket = (typeof CLASSIFICATION_BUCKETS)[number];

export interface ClassificationPointInput {
  origin: ClassificationOrigin;
  classificationType?: ClassificationType;
  releaseId?: string | null;
  sourceId?: string | null;
  provider?: string | null;
  model?: string | null;
  choice?: string | null;
  disposition: ClassificationDisposition;
  reason?: string | null;
  policyVersion?: string | null;
  failureCategory?: string | null;
  selectedChoiceProbability?: number | null;
  providerConfidence?: number | null;
  threshold?: number | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
}

export interface ClassificationDataPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

export interface ClassificationDataset {
  writeDataPoint(point: ClassificationDataPoint): void;
}

const SOURCE_ID_RE = /^src_[A-Za-z0-9_-]{1,64}$/;
const RELEASE_ID_RE = /^rel_[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_.:/@+-]{1,80}$/;

function token(value: string | null | undefined, fallback = ""): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  return TOKEN_RE.test(trimmed) ? trimmed : fallback;
}

/** Probability-like scores. Valid domain is 0..1; anything else is absent. */
export function unitOrAbsent(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return ABSENT_DOUBLE;
  }
  return value;
}

/** Costs, token counts, and durations. Negative and non-finite values are absent. */
export function nonNegativeOrAbsent(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return ABSENT_DOUBLE;
  }
  return value;
}

export function classificationDatasetName(environment: string | undefined): string {
  return environment === "staging" ? DATASET_STAGING : DATASET_PRODUCTION;
}

export function classificationEnvironment(environment: string | undefined): string {
  if (environment === "production" || environment === "staging") return environment;
  return "development";
}

export function encodeClassificationPoint(
  environment: string | undefined,
  input: ClassificationPointInput,
): ClassificationDataPoint {
  const sourceId = input.sourceId && SOURCE_ID_RE.test(input.sourceId) ? input.sourceId : "";
  const releaseId = input.releaseId && RELEASE_ID_RE.test(input.releaseId) ? input.releaseId : "";
  return {
    indexes: [sourceId || NO_SOURCE_INDEX],
    blobs: [
      CLASSIFICATION_SCHEMA_VERSION,
      classificationEnvironment(environment),
      input.origin,
      input.classificationType ?? "marketing",
      releaseId,
      sourceId,
      token(input.provider, "unknown"),
      token(input.model, "unknown"),
      token(input.choice, ""),
      input.disposition,
      token(input.reason, ""),
      token(input.policyVersion, MARKETING_POLICY_VERSION),
      token(input.failureCategory, ""),
    ],
    doubles: [
      unitOrAbsent(input.selectedChoiceProbability),
      unitOrAbsent(input.providerConfidence),
      nonNegativeOrAbsent(input.threshold ?? MARKETING_SUPPRESSION_THRESHOLD),
      nonNegativeOrAbsent(input.costUsd),
      nonNegativeOrAbsent(input.inputTokens),
      nonNegativeOrAbsent(input.outputTokens),
      nonNegativeOrAbsent(input.durationMs),
      1,
    ],
  };
}

/** Best-effort write. A missing binding or a thrown write never fails the caller. */
export function writeClassificationPoint(
  dataset: ClassificationDataset | undefined,
  environment: string | undefined,
  input: ClassificationPointInput,
): void {
  if (!dataset) return;
  try {
    dataset.writeDataPoint(encodeClassificationPoint(environment, input));
  } catch (err) {
    logEvent("warn", {
      component: "classification-analytics",
      event: "classification-point-write-failed",
      origin: input.origin,
      disposition: input.disposition,
      err,
    });
  }
}
