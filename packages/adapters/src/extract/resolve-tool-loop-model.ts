/**
 * Shared OpenRouter → Anthropic AI-SDK resolver for extraction. Originally
 * built for the large-body tool-loop, it's also the seam the one-shot tier
 * resolves through (issue #2166) — callers just pass a different
 * `anthropicModel` fallback (Sonnet-class for the tool-loop, Haiku-class for
 * one-shot) since both tiers share the same `EXTRACT_MODEL` / OpenRouter key.
 * Callers resolve flags/secrets, then pass plain values here.
 */

import { buildLaneAnthropicModel } from "../lane-model.js";
import { buildOpenRouterExtractModel } from "./openrouter-model.js";
import { logEvent } from "@releases/lib/log-event";

export interface ResolveToolLoopAiSdkModelInput {
  openrouterEnabled: boolean;
  extractModel?: string;
  openRouterApiKey?: string | null;
  openRouterBaseURL?: string;
  anthropicApiKey?: string;
  anthropicModel: string;
  anthropicBaseURL?: string;
  aiGatewayToken?: string;
  /** `logEvent` component for misconfiguration warnings. */
  logComponent: string;
}

export interface ResolvedExtractAiSdkModel {
  model: unknown;
  label: string;
  /** Which branch resolved — lets callers emit `ai_usage` telemetry without
   *  re-deriving the provider from the label's shape. */
  provider: "openrouter" | "anthropic";
}

/** @returns AI-SDK `{ model, label, provider }`, or `undefined` when no key is usable. */
export function resolveToolLoopAiSdkModel(
  input: ResolveToolLoopAiSdkModelInput,
): ResolvedExtractAiSdkModel | undefined {
  if (input.openrouterEnabled) {
    const model = input.extractModel?.trim();
    if (!model) {
      logEvent("warn", {
        component: input.logComponent,
        event: "openrouter-misconfigured",
        reason: "EXTRACT_MODEL empty",
      });
    } else if (input.openRouterApiKey) {
      const baseURL = input.openRouterBaseURL?.trim();
      return {
        model: buildOpenRouterExtractModel({
          apiKey: input.openRouterApiKey,
          model,
          ...(baseURL ? { baseURL } : {}),
        }),
        label: model,
        provider: "openrouter",
      };
    } else {
      logEvent("warn", {
        component: input.logComponent,
        event: "openrouter-misconfigured",
        reason: "OPENROUTER_API_KEY unresolved",
        model,
      });
    }
  }

  if (!input.anthropicApiKey) return undefined;
  return {
    model: buildLaneAnthropicModel({
      apiKey: input.anthropicApiKey,
      model: input.anthropicModel,
      ...(input.anthropicBaseURL ? { baseURL: input.anthropicBaseURL } : {}),
      ...(input.aiGatewayToken ? { gatewayToken: input.aiGatewayToken } : {}),
    }),
    label: input.anthropicModel,
    provider: "anthropic",
  };
}
