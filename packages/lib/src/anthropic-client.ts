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
  /**
   * Pass `"https://api.anthropic.com"` to force a direct call regardless of
   * the `ANTHROPIC_BASE_URL` env var (the SDK auto-reads it; passing nothing
   * here lets the env value win). Pass the gateway sub-path to route through
   * Cloudflare AI Gateway. See docs/architecture/ai-gateway.md for which
   * call sites should bypass the gateway.
   */
  baseURL?: string;
  gatewayToken?: string;
  timeoutMs?: number;
  /**
   * Additional headers attached to every request. Merged with the
   * `cf-aig-authorization` header when `gatewayToken` is set.
   */
  defaultHeaders?: Record<string, string>;
}

export function buildAnthropicClient(opts: AnthropicClientOptions): Anthropic {
  const { apiKey, baseURL, gatewayToken, timeoutMs, defaultHeaders } = opts;
  const mergedHeaders: Record<string, string> = {
    ...defaultHeaders,
    ...(gatewayToken ? { "cf-aig-authorization": `Bearer ${gatewayToken}` } : {}),
  };
  const hasHeaders = Object.keys(mergedHeaders).length > 0;
  return new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    ...(hasHeaders ? { defaultHeaders: mergedHeaders } : {}),
  });
}
