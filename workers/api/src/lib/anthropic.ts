/**
 * Thin wrapper around the Anthropic SDK for worker routes. Errors from
 * `anthropic.messages.create()` propagate unmodified so callers can
 * `instanceof APIError` / classify via `@releases/lib/anthropic-errors`.
 *
 * Optional `baseURL` routes calls through Cloudflare AI Gateway; optional
 * `gatewayToken` adds the `cf-aig-authorization` bearer header when the
 * gateway is configured in authenticated mode.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";

const DEFAULT_TIMEOUT_MS = 90_000;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AnthropicRequest {
  model: string;
  system: string;
  messages: AnthropicMessage[];
  maxTokens: number;
}

export interface AnthropicResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface GatewayOptions {
  baseURL?: string;
  gatewayToken?: string;
}

// Cache the client per isolate to amortize constructor cost across requests.
// Cache key includes `baseURL` so flipping the gateway env var takes effect on
// the next deploy without a stale client lingering across isolates.
let cachedClient: Anthropic | undefined;
let cachedKey: string | undefined;

function getClient(apiKey: string, opts: GatewayOptions): Anthropic {
  const cacheKey = `${apiKey}::${opts.baseURL ?? ""}::${opts.gatewayToken ?? ""}`;
  if (cachedClient && cachedKey === cacheKey) return cachedClient;
  cachedClient = buildAnthropicClient({
    apiKey,
    baseURL: opts.baseURL,
    gatewayToken: opts.gatewayToken,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  cachedKey = cacheKey;
  return cachedClient;
}

export async function callAnthropic(
  apiKey: string,
  req: AnthropicRequest,
  opts: GatewayOptions = {},
): Promise<AnthropicResult> {
  const response = await getClient(apiKey, opts).messages.create({
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: req.messages,
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text" || !textBlock.text) {
    throw new Error("Anthropic returned no text content");
  }
  return {
    text: textBlock.text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
