/**
 * Construct an Anthropic SDK client, optionally routed through Cloudflare
 * AI Gateway. Set `baseURL` to the gateway's Anthropic sub-path
 * (`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`)
 * to proxy requests; pass `gatewayToken` when the gateway is configured
 * in authenticated mode.
 *
 * Errors surface unchanged so callers can still `instanceof APIError`
 * / classify via `@releases/lib/anthropic-errors`.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface AnthropicClientOptions {
  apiKey: string;
  baseURL?: string;
  gatewayToken?: string;
  timeoutMs?: number;
}

export function buildAnthropicClient(opts: AnthropicClientOptions): Anthropic {
  const { apiKey, baseURL, gatewayToken, timeoutMs } = opts;
  return new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    ...(gatewayToken
      ? { defaultHeaders: { "cf-aig-authorization": `Bearer ${gatewayToken}` } }
      : {}),
  });
}
