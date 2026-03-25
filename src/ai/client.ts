import Anthropic from "@anthropic-ai/sdk";
import { config } from "../lib/config.js";
import { AIError } from "../lib/errors.js";

let cachedClient: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (cachedClient) return cachedClient;

  const apiKey = config.anthropicApiKey();
  if (!apiKey) {
    throw new AIError("Anthropic API key is not set. Set ANTHROPIC_API_KEY environment variable.");
  }

  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}
