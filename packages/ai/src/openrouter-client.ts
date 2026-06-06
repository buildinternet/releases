/**
 * Worker-safe transport to OpenRouter's OpenAI-compatible chat-completions API.
 * No SDK, no `fs` — just `fetch`. `baseURL` may point at OpenRouter directly or
 * at a Cloudflare AI Gateway `openrouter` provider sub-path for unified
 * observability. Errors surface as a plain `Error` (status + truncated body);
 * callers that need fail-open behavior catch and fall back.
 *
 * This is the OpenAI-protocol sibling of `@releases/lib`'s `buildAnthropicClient`
 * (Anthropic Messages protocol). The two are NOT wire-compatible, which is why
 * OpenRouter needs its own transport rather than a `baseURL` swap on the SDK.
 */

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  /** Defaults to `https://openrouter.ai/api/v1`. Pass an AI Gateway sub-path to proxy. */
  baseURL?: string;
  /** Optional OpenRouter ranking headers (https://openrouter.ai/docs/api-reference). */
  referer?: string;
  title?: string;
  timeoutMs?: number;
}

export interface OpenRouterRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface OpenRouterUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  /** Provider-reported cost in USD when `usage.include` is honored. */
  costUsd?: number;
}

export interface OpenRouterResult {
  text: string;
  usage: OpenRouterUsage;
}

const DEFAULT_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

export async function openRouterChat(
  opts: OpenRouterOptions,
  req: OpenRouterRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterResult> {
  const base = (opts.baseURL ?? DEFAULT_BASE).replace(/\/$/, "");
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      ...(opts.referer ? { "HTTP-Referer": opts.referer } : {}),
      ...(opts.title ? { "X-Title": opts.title } : {}),
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      // Ask OpenRouter to include token + cost accounting in the response.
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  const text = json.choices?.[0]?.message?.content ?? "";
  const u = json.usage ?? {};
  return {
    text,
    usage: {
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
      cacheCreate: 0,
      cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
      ...(typeof u.cost === "number" ? { costUsd: u.cost } : {}),
    },
  };
}
