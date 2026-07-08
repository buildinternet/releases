/**
 * Shared OpenRouter → Anthropic AI-SDK resolver for the large-body extraction
 * tool-loop. Callers resolve flags/secrets, then pass plain values here.
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

/** @returns AI-SDK `{ model, label }` for the tool-loop, or `undefined` when no key is usable. */
export function resolveToolLoopAiSdkModel(
  input: ResolveToolLoopAiSdkModelInput,
): { model: unknown; label: string } | undefined {
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
  };
}
