/**
 * JEV decision model for semantic alerts. Always `typesafe/jev-1.13` via the
 * OpenRouter Decisions seam the marketing classifier uses. There is no
 * Anthropic fallback: a missing key or a constructor failure returns null and
 * the caller notifies nobody.
 */
import { aisdkDecisionModel } from "@releases/ai-internal/aisdk-decision-model";
import type { NoulBatchModel } from "@releases/ai-internal/decision-model";
import { MARKETING_DECISION_MODEL } from "@releases/core-internal/ai-lane-models";
import { buildLaneOpenRouterDecisionModel } from "@releases/adapters/lane-model";
import { logEvent } from "@releases/lib/log-event";
import { getSecret, type SecretBinding } from "@releases/lib/secrets";

export interface SemanticAlertModelEnv {
  ENVIRONMENT?: string;
  OPENROUTER_API_KEY?: SecretBinding;
  OPENROUTER_BASE_URL?: string;
}

export async function resolveSemanticAlertModel(
  env: SemanticAlertModelEnv,
): Promise<NoulBatchModel | null> {
  const key = await getSecret(env.OPENROUTER_API_KEY).catch(() => null);
  if (!key) {
    logEvent("warn", {
      component: "semantic-alerts",
      event: "model-unavailable",
      reason: "openrouter-key-missing",
    });
    return null;
  }
  try {
    return aisdkDecisionModel(
      buildLaneOpenRouterDecisionModel({
        apiKey: key,
        model: MARKETING_DECISION_MODEL,
        baseURL: env.OPENROUTER_BASE_URL?.trim() || undefined,
        referer: "https://releases.sh",
        title: "Releases",
        sessionId: "semantic-alert-match",
        trace: { generationName: "semantic-alert-match", environment: env.ENVIRONMENT },
      }),
      `openrouter:${MARKETING_DECISION_MODEL}`,
    );
  } catch (err) {
    logEvent("warn", {
      component: "semantic-alerts",
      event: "model-unavailable",
      reason: "openrouter-misconfigured",
      errName: err instanceof Error ? err.name : "Error",
    });
    return null;
  }
}
