/**
 * Runtime overlay of the operator-picked marketing-classifier suppression
 * threshold on top of `DEFAULT_MARKETING_THRESHOLD`. Stored in `site_settings`
 * (`marketing_classifier`); isolate-local cache (30s TTL, same shape as
 * `../ai/ai-lane-models.ts`) so ingest doesn't hit D1 on every classify call.
 * Fail-open to the default on any D1 error.
 */
import {
  DEFAULT_MARKETING_THRESHOLD,
  parseMarketingClassifierThreshold,
} from "@releases/core-internal/marketing-classifier-settings";
import { createDb, type AnyDb } from "../../db.js";
import { getStoredMarketingThreshold } from "../../queries/site-settings.js";
import { logEvent } from "@releases/lib/log-event";

const THRESHOLD_TTL_MS = 30_000;

let thresholdCache: { at: number; threshold: number } | null = null;

export function clearMarketingThresholdCache(): void {
  thresholdCache = null;
}

export interface MarketingThresholdEnv {
  DB?: D1Database | AnyDb;
}

/** Effective suppression threshold: operator override, else the code default. */
export async function loadMarketingThreshold(
  db: MarketingThresholdEnv["DB"] | undefined,
): Promise<number> {
  if (!db) return thresholdCache?.threshold ?? DEFAULT_MARKETING_THRESHOLD;
  if (thresholdCache && Date.now() - thresholdCache.at < THRESHOLD_TTL_MS) {
    return thresholdCache.threshold;
  }
  try {
    const stored = await getStoredMarketingThreshold(createDb(db as D1Database));
    thresholdCache = { at: Date.now(), threshold: stored.threshold };
    return stored.threshold;
  } catch (err) {
    logEvent("warn", {
      component: "marketing-classifier-settings",
      event: "threshold-load-failed",
      err: err instanceof Error ? err : String(err),
    });
    return thresholdCache?.threshold ?? DEFAULT_MARKETING_THRESHOLD;
  }
}

export { parseMarketingClassifierThreshold, DEFAULT_MARKETING_THRESHOLD };
