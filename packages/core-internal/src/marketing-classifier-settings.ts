/**
 * Operator-editable marketing-classifier suppression threshold. Stored as JSON
 * under the `marketing_classifier` key of `site_settings`, sibling of
 * `ai_lane_models` (see ai-lane-models.ts). Missing / malformed / out-of-range
 * values fall through to `DEFAULT_MARKETING_THRESHOLD` — fail-safe, never throws.
 */

export const MARKETING_CLASSIFIER_SETTING_KEY = "marketing_classifier";

/**
 * Default selected-choice probability at or above which a marketing-labeled
 * item suppresses. Lowered from 0.80 to 0.65 (2026-09) from a prod dry-run:
 * every marketing-labeled item scoring 0.65–0.80 was genuine marketing.
 * Must match `MARKETING_SUPPRESSION_THRESHOLD` in
 * `@releases/ai-internal/marketing-classifier` (duplicated across the
 * decoupled packages/ai ↔ core-internal boundary, same as MARKETING_DECISION_MODEL).
 */
export const DEFAULT_MARKETING_THRESHOLD = 0.65;

export const MARKETING_THRESHOLD_MIN = 0.5;
export const MARKETING_THRESHOLD_MAX = 0.99;

export interface MarketingClassifierSettings {
  threshold: number;
}

export function isValidMarketingThreshold(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MARKETING_THRESHOLD_MIN &&
    value <= MARKETING_THRESHOLD_MAX
  );
}

/** Parse a stored `marketing_classifier` JSON value. Fail-safe: never throws. */
export function parseMarketingClassifierThreshold(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_MARKETING_THRESHOLD;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_MARKETING_THRESHOLD;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_MARKETING_THRESHOLD;
  const value = (parsed as Record<string, unknown>).threshold;
  return isValidMarketingThreshold(value) ? value : DEFAULT_MARKETING_THRESHOLD;
}
