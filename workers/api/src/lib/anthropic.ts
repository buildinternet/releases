/**
 * Thin wrapper around the Anthropic SDK for worker routes. Errors from
 * `anthropic.messages.create()` propagate unmodified so callers can
 * `instanceof APIError` / classify via `@releases/lib/anthropic-errors`.
 */

import Anthropic from "@anthropic-ai/sdk";

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

// Cache the client per isolate to amortize constructor cost across requests.
// `ANTHROPIC_API_KEY` comes from a Secrets Store binding so the value is
// stable for the life of the isolate; keying on it handles test/mocking
// scenarios that swap keys.
let cachedClient: Anthropic | undefined;
let cachedKey: string | undefined;

function getClient(apiKey: string): Anthropic {
  if (cachedClient && cachedKey === apiKey) return cachedClient;
  cachedClient = new Anthropic({ apiKey, timeout: DEFAULT_TIMEOUT_MS });
  cachedKey = apiKey;
  return cachedClient;
}

export async function callAnthropic(
  apiKey: string,
  req: AnthropicRequest,
): Promise<AnthropicResult> {
  const response = await getClient(apiKey).messages.create({
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
