/**
 * Minimal Anthropic messages client for Worker routes. Uses `fetch` directly
 * to keep the worker bundle lean and to match the pattern in
 * `workers/api/src/cron/scrape-agent-sweep.ts` (runPreflight).
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
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
  timeoutMs?: number;
}

export interface AnthropicResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export class AnthropicError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AnthropicError";
  }
}

export async function callAnthropic(
  apiKey: string,
  req: AnthropicRequest,
): Promise<AnthropicResult> {
  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new AnthropicError(`Anthropic request timed out after ${timeoutMs}ms`, 504);
    }
    throw new AnthropicError(
      `Anthropic request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AnthropicError(
      `Anthropic API returned ${res.status}: ${body.slice(0, 200)}`,
      res.status,
    );
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const textBlock = data.content?.find((b) => b.type === "text");
  if (!textBlock?.text) {
    throw new AnthropicError("Anthropic returned no text content");
  }
  return {
    text: textBlock.text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}
