/**
 * Anthropic secret + gateway resolution for worker routes. Call sites that need
 * a client construct one via `buildAnthropicClient`; this module only resolves
 * env bindings.
 */

import { getSecret } from "@releases/lib/secrets";

export interface GatewayOptions {
  baseURL?: string;
  gatewayToken?: string;
}

type SecretBinding = { get(): Promise<string> };

export interface AnthropicEnv {
  ANTHROPIC_API_KEY?: SecretBinding;
  ANTHROPIC_BASE_URL?: string;
  AI_GATEWAY_TOKEN?: SecretBinding;
}

export async function getAnthropicKey(env: AnthropicEnv): Promise<string | null> {
  const key = await getSecret(env.ANTHROPIC_API_KEY);
  return key && key.length > 0 ? key : null;
}

export async function resolveGatewayOpts(env: AnthropicEnv): Promise<GatewayOptions> {
  const baseURL = env.ANTHROPIC_BASE_URL?.trim();
  const gatewayToken = (await getSecret(env.AI_GATEWAY_TOKEN).catch(() => null))?.trim();
  return {
    ...(baseURL ? { baseURL } : {}),
    ...(gatewayToken ? { gatewayToken } : {}),
  };
}
