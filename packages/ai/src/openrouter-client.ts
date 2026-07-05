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

/**
 * Static Broadcast trace tags attached to every request from one model
 * instance. OpenRouter forwards these to a configured Broadcast destination
 * (Axiom via OTLP, Langfuse, …) for grouping; they are *silently ignored* until
 * Broadcast is enabled in the OpenRouter dashboard, so populating them is inert
 * and safe. Only labels live here — no prompt/completion content — so these
 * fields are never a PII concern (the model messages are; gate those with the
 * destination's Privacy Mode).
 */
export interface OpenRouterTrace {
  /** Stable name for this lane — e.g. "summarize-release", "marketing-classifier". */
  generationName?: string;
  /** "production" | "staging" | "eval" — separates prod traffic from eval runs. */
  environment?: string;
  feature?: string;
  version?: string;
}

/**
 * OpenRouter's unified `reasoning` control, normalized across providers. The
 * cheap fixed-budget summarize lanes pass `{ enabled: false }`: DeepSeek V4 (and
 * any other reasoning model) otherwise spends the small `max_tokens` budget on
 * reasoning tokens and returns empty visible content, which `parseCollection-
 * Summary` rejects as a missing `<title>`. Inert on non-reasoning models —
 * OpenRouter normalizes/ignores it — so it is safe to set unconditionally on a
 * lane that never wants reasoning regardless of which model is configured.
 */
export interface OpenRouterReasoning {
  /** `false` disables reasoning entirely. */
  enabled?: boolean;
  effort?: "low" | "medium" | "high";
  max_tokens?: number;
  /** Reason internally but omit reasoning from the response. */
  exclude?: boolean;
}

/**
 * OpenRouter provider-routing preferences (a subset of the documented `provider`
 * object: https://openrouter.ai/docs/guides/routing/provider-selection). Threaded
 * so a latency-sensitive lane can steer routing per request — e.g. `ignore` a
 * provider whose latency is an outlier for a given model. Account-wide provider
 * preferences set in the OpenRouter dashboard apply on top of this; the two
 * compose (the union of ignored providers is excluded).
 */
export interface OpenRouterProviderPrefs {
  /** Provider slugs to never route to (e.g. `["gmicloud"]`). */
  ignore?: string[];
  /** Restrict routing to exactly these provider slugs, in order. */
  only?: string[];
  /** Allow falling back to other providers if the preferred ones fail. */
  allow_fallbacks?: boolean;
  /** Sort candidate providers by this axis before routing. */
  sort?: "price" | "throughput" | "latency";
}

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  /** Defaults to `https://openrouter.ai/api/v1`. Pass an AI Gateway sub-path to proxy. */
  baseURL?: string;
  /**
   * Reasoning control for reasoning-capable models. Omitted from the wire when
   * unset (provider default applies). See `OpenRouterReasoning`.
   */
  reasoning?: OpenRouterReasoning;
  /**
   * Provider-routing preferences. Omitted from the wire when unset (OpenRouter's
   * default routing + any account-level dashboard preferences apply). See
   * `OpenRouterProviderPrefs`.
   */
  provider?: OpenRouterProviderPrefs;
  /**
   * Optional OpenRouter ranking headers. `referer` (sent as `HTTP-Referer`) is
   * the app *identity* — it keys the app page + rankings. `title` is display-only
   * (the app's shown name); it does NOT segment usage. Keep `title` stable across
   * all lanes and use `trace.generationName` to break traffic out per lane.
   */
  referer?: string;
  title?: string;
  timeoutMs?: number;
  /** Optional Broadcast observability tags (see `OpenRouterTrace`). */
  trace?: OpenRouterTrace;
  /**
   * Top-level OpenRouter Broadcast grouping id (NOT inside `trace`). Collapses
   * related requests — a conversation or agent workflow — into one trace. The
   * intended consumer is the extraction tool-loop, which fires many OpenRouter
   * calls per source-fetch: a shared `sessionId` groups all rounds into a single
   * trace. Single-shot lanes (marketing-classifier, summarize) can leave it unset.
   * Sent as both the `session_id` body field and the `x-session-id` header.
   * Truncated to 128 chars defensively.
   */
  sessionId?: string;
  /**
   * Top-level OpenRouter Broadcast end-user id (NOT inside `trace`). Associates
   * traces with a specific end-user. Optional; truncated to 128 chars defensively.
   */
  user?: string;
}

/** OpenRouter caps `session_id` / `user` at 128 chars; clamp defensively. */
const MAX_TRACE_FIELD_LEN = 128;

/**
 * Map the camelCase trace tags to OpenRouter's snake_case `trace` body shape,
 * dropping unset keys. Returns `undefined` when nothing is set so the body merge
 * omits the field entirely (no empty `trace: {}` on the wire).
 */
function serializeTrace(trace: OpenRouterTrace | undefined): Record<string, string> | undefined {
  if (!trace) return undefined;
  const out: Record<string, string> = {};
  if (trace.generationName) out.generation_name = trace.generationName;
  if (trace.environment) out.environment = trace.environment;
  if (trace.feature) out.feature = trace.feature;
  if (trace.version) out.version = trace.version;
  return Object.keys(out).length > 0 ? out : undefined;
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
  /** True when the model stopped on `finish_reason: "length"` — output cut off at max_tokens. */
  truncated?: boolean;
}

const DEFAULT_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

export async function openRouterChat(
  opts: OpenRouterOptions,
  req: OpenRouterRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterResult> {
  const base = (opts.baseURL ?? DEFAULT_BASE).replace(/\/$/, "");
  const trace = serializeTrace(opts.trace);
  // Top-level Broadcast grouping fields (NOT inside `trace`); clamp to 128 chars.
  const sessionId = opts.sessionId ? opts.sessionId.slice(0, MAX_TRACE_FIELD_LEN) : undefined;
  const user = opts.user ? opts.user.slice(0, MAX_TRACE_FIELD_LEN) : undefined;
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      ...(opts.referer ? { "HTTP-Referer": opts.referer } : {}),
      // Send both the legacy (`X-Title`) and current (`X-OpenRouter-Title`)
      // display-name headers so the app name shows regardless of which OpenRouter
      // honors; attribution itself rides on `HTTP-Referer` either way.
      ...(opts.title ? { "X-Title": opts.title, "X-OpenRouter-Title": opts.title } : {}),
      // Belt-and-suspenders: the docs accept `session_id` via header too.
      ...(sessionId ? { "x-session-id": sessionId } : {}),
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
      // Reasoning control — omitted entirely when unset (provider default).
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      // Provider-routing preferences — omitted entirely when unset.
      ...(opts.provider ? { provider: opts.provider } : {}),
      // Broadcast observability tags — inert until Broadcast is configured.
      ...(trace ? { trace } : {}),
      // Top-level Broadcast grouping fields — omitted entirely when unset.
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(user ? { user } : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
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
    truncated: json.choices?.[0]?.finish_reason === "length",
    usage: {
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
      cacheCreate: 0,
      cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
      ...(typeof u.cost === "number" ? { costUsd: u.cost } : {}),
    },
  };
}
