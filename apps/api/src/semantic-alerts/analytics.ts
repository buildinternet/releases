/**
 * Structured Analytics Engine points for semantic-alert decisions.
 *
 * Same dataset and positional layout as marketing classification so a later
 * dashboard can share the reader. `blob4` is `semantic-alert`, which the
 * marketing admin queries exclude (`blob4 = 'marketing'`).
 *
 * The freeform alert query is not a field on this point. Do not add one.
 * Cost stays on the `ai_usage` log: one JEV call covers many alerts, so a
 * per-alert cost double would over-count.
 */
import { SEMANTIC_ALERT_POLICY_VERSION } from "@releases/ai-internal/semantic-alert-match";
import { logEvent } from "@releases/lib/log-event";
import {
  ABSENT_DOUBLE,
  classificationEnvironment,
  nonNegativeOrAbsent,
  unitOrAbsent,
} from "../lib/classification/classification-schema.js";

const SCHEMA_VERSION = "1";
const NO_SOURCE_INDEX = "none";
const SOURCE_ID_RE = /^src_[A-Za-z0-9_-]{1,64}$/;
const RELEASE_ID_RE = /^rel_[A-Za-z0-9_-]{1,64}$/;
const ALERT_ID_RE = /^sal_[A-Za-z0-9-]{1,80}$/;
const TOKEN_RE = /^[A-Za-z0-9_.:/+-]{1,80}$/;

export interface SemanticAlertPointInput {
  releaseId: string;
  sourceId: string;
  alertId: string;
  provider: string;
  model: string;
  disposition: "matched" | "below_threshold" | "failed";
  failureCategory?: string | null;
  probability?: number | null;
  threshold?: number | null;
}

export interface SemanticAlertDataset {
  writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }): void;
}

function token(value: string | null | undefined, fallback = ""): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  return TOKEN_RE.test(trimmed) ? trimmed : fallback;
}

export function encodeSemanticAlertPoint(
  environment: string | undefined,
  input: SemanticAlertPointInput,
): { indexes: string[]; blobs: string[]; doubles: number[] } {
  const sourceId = SOURCE_ID_RE.test(input.sourceId) ? input.sourceId : "";
  const releaseId = RELEASE_ID_RE.test(input.releaseId) ? input.releaseId : "";
  const alertId = ALERT_ID_RE.test(input.alertId) ? input.alertId : "";
  const choice =
    input.disposition === "matched"
      ? "true"
      : input.disposition === "below_threshold"
        ? "false"
        : "";
  return {
    indexes: [sourceId || NO_SOURCE_INDEX],
    blobs: [
      SCHEMA_VERSION,
      classificationEnvironment(environment),
      "ingest",
      "semantic-alert",
      releaseId,
      sourceId,
      token(input.provider, "openrouter"),
      token(input.model, "unknown"),
      choice,
      input.disposition,
      alertId,
      SEMANTIC_ALERT_POLICY_VERSION,
      token(input.failureCategory, ""),
    ],
    doubles: [
      unitOrAbsent(input.probability),
      ABSENT_DOUBLE,
      nonNegativeOrAbsent(input.threshold),
      ABSENT_DOUBLE,
      ABSENT_DOUBLE,
      ABSENT_DOUBLE,
      ABSENT_DOUBLE,
      1,
    ],
  };
}

export function writeSemanticAlertPoint(
  dataset: SemanticAlertDataset | undefined,
  environment: string | undefined,
  input: SemanticAlertPointInput,
): void {
  if (!dataset) return;
  try {
    dataset.writeDataPoint(encodeSemanticAlertPoint(environment, input));
  } catch (err) {
    logEvent("warn", {
      component: "semantic-alerts",
      event: "semantic-alert-point-write-failed",
      alertId: input.alertId,
      releaseId: input.releaseId,
      disposition: input.disposition,
      errName: err instanceof Error ? err.name : "Error",
    });
  }
}
