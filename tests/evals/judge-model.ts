/**
 * Shared eval-model plumbing for the local eval suites: the cross-provider
 * "model under test" resolver ({@link resolveEvalModel}) used by the model-comparison
 * evals (`marketing-classifier`, `release-summary`, `article-extract`), and the
 * LLM-as-judge helpers (`resolveJudgeModel` / `runJudge`) used by the rubric-judged
 * suites (`release-summary.eval.ts`, `overview.eval.ts`). Both build a
 * provider-agnostic `TextModel` from env — OpenRouter when a candidate model is
 * configured, the Anthropic production baseline otherwise.
 *
 * The judge runs on a cheap OpenRouter model by default (Gemini 2.5 Flash via
 * the provider-agnostic `TextModel` seam) — a spike found it ~15x cheaper and
 * ~4x faster than Sonnet while catching every objective faithfulness violation
 * and emitting clean JSON. Its only divergence from Sonnet is a stricter reading
 * of the subjective "lead-with-the-user-outcome" criteria, so eval pass-rates
 * are baselined against it, not against Sonnet history.
 *
 * Override via `JUDGE_MODEL`: an Anthropic id (`claude-…`) judges with the SDK
 * (needs `ANTHROPIC_API_KEY`); anything else is treated as an OpenRouter model
 * slug (needs `OPENROUTER_API_KEY`). e.g. `JUDGE_MODEL=claude-sonnet-4-6` to go
 * back to Sonnet, or `JUDGE_MODEL=google/gemini-2.5-flash-lite` for cheaper.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  anthropicTextModel,
  openRouterTextModel,
  type TextModel,
} from "@releases/ai-internal/text-model";
import {
  buildOverviewOpenRouterModel,
  buildOverviewAnthropicModel,
} from "@releases/adapters/overview-model";
import type { LanguageModel } from "ai";

/**
 * Pull the JSON verdict out of the judge's raw text. The grader prompt asks for
 * a bare object, but models still tend to wrap it in ```json fences or a
 * one-line preamble ("Here is my evaluation:"), which makes a direct JSON.parse
 * throw — every fixture then scores "unparseable". Strip a fenced block if
 * present, else take the outermost {...} span, before parsing.
 */
export function extractJudgeJson(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

export interface EvalModelOptions {
  /** Anthropic model id used as the production-baseline default (the eval's `MODEL`). */
  anthropicModel: string;
  /** Broadcast trace tag (`generationName`) distinguishing this eval's OpenRouter runs. */
  generationName: string;
  /** Env var naming the OpenRouter candidate model — `EVAL_MODEL` or `EVAL_OPENROUTER_MODEL`. */
  orModelEnvVar: string;
  /**
   * Reuse an existing Anthropic client (e.g. the one a judged eval already built)
   * instead of constructing one from `ANTHROPIC_API_KEY`. When provided, the
   * Anthropic fallback is always available, so the result is never null.
   */
  client?: Anthropic;
}

/**
 * Resolve the cross-provider "model under test" for a local eval. Defaults to
 * the production-baseline Anthropic model; when `OPENROUTER_API_KEY` + the named
 * OpenRouter model env var are both set, evaluates that OpenRouter candidate
 * against the same prompt + fixtures (`OPENROUTER_BASE_URL` optionally routes
 * through an AI Gateway sub-path). The returned `label` is the `<provider>:<model>`
 * id used for run attribution. Returns null only when no provider key is
 * available (no `client` and no `ANTHROPIC_API_KEY`) — the caller skips the run.
 */
export function resolveEvalModel(
  opts: EvalModelOptions,
): { model: TextModel; label: string } | null {
  const orKey = process.env.OPENROUTER_API_KEY?.trim();
  const orModel = process.env[opts.orModelEnvVar]?.trim();
  if (orKey && orModel) {
    return {
      model: openRouterTextModel({
        apiKey: orKey,
        model: orModel,
        ...(process.env.OPENROUTER_BASE_URL?.trim()
          ? { baseURL: process.env.OPENROUTER_BASE_URL.trim() }
          : {}),
        referer: "https://releases.sh",
        title: "Releases",
        // Tag eval runs so Broadcast traces stay separate from prod traffic.
        trace: { generationName: opts.generationName, environment: "eval" },
      }),
      label: `openrouter:${orModel}`,
    };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const client = opts.client ?? (apiKey ? new Anthropic({ apiKey }) : null);
  if (client) {
    return {
      model: anthropicTextModel(client, opts.anthropicModel),
      label: `anthropic:${opts.anthropicModel}`,
    };
  }
  return null;
}

/**
 * Resolve the "model under test" for the org-overview eval. UNLIKE
 * {@link resolveEvalModel} (which returns the provider-agnostic `TextModel` the
 * other evals grade), the overview lane runs through the AI SDK structured-output
 * path (`generateText` + `Output.object`), so `generateOverview` needs an AI SDK
 * `LanguageModel`. This mirrors production `resolveOverviewModel`
 * (workers/api/src/lib/text-model.ts): OpenRouter when the candidate model env var
 * + `OPENROUTER_API_KEY` are set, else the Anthropic baseline via
 * `buildOverviewAnthropicModel`. Kept separate so the shared `resolveEvalModel`
 * stays a `TextModel` for the other suites. Returns null only when no provider is
 * usable (no OpenRouter pair and no Anthropic key).
 */
export function resolveOverviewEvalModel(opts: {
  /** Anthropic model id used as the production-baseline default (the eval's `MODEL`). */
  anthropicModel: string;
  /** Sticky-routing + Broadcast grouping key for OpenRouter runs (e.g. "org-overview-eval"). */
  generationName: string;
  /** Env var naming the OpenRouter candidate model (e.g. `OVERVIEW_EVAL_MODEL`). */
  orModelEnvVar: string;
  /** Anthropic API key for the fallback; defaults to `ANTHROPIC_API_KEY`. */
  apiKey?: string;
}): { model: LanguageModel; label: string } | null {
  const orKey = process.env.OPENROUTER_API_KEY?.trim();
  const orModel = process.env[opts.orModelEnvVar]?.trim();
  if (orKey && orModel) {
    const baseURL = process.env.OPENROUTER_BASE_URL?.trim();
    return {
      model: buildOverviewOpenRouterModel({
        apiKey: orKey,
        model: orModel,
        ...(baseURL ? { baseURL } : {}),
        sessionId: opts.generationName,
        referer: "https://releases.sh",
        title: "Releases",
      }),
      label: `openrouter:${orModel}`,
    };
  }
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    return {
      model: buildOverviewAnthropicModel({ apiKey, model: opts.anthropicModel }),
      label: `anthropic:${opts.anthropicModel}`,
    };
  }
  return null;
}

/** Default judge: a cheap OpenRouter model. Override with the `JUDGE_MODEL` env var. */
export const DEFAULT_JUDGE_MODEL = "google/gemini-2.5-flash";

/**
 * Resolve the judge model. Defaults to {@link DEFAULT_JUDGE_MODEL} on OpenRouter;
 * `JUDGE_MODEL` overrides it. An `claude-…` id routes through the Anthropic SDK;
 * any other id is an OpenRouter slug (requires `OPENROUTER_API_KEY`).
 */
export function resolveJudgeModel(client: Anthropic): TextModel {
  const id = process.env.JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL;
  if (id.startsWith("claude-")) {
    return anthropicTextModel(client, id);
  }
  const orKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!orKey) {
    throw new Error(
      `Judge model "${id}" needs OPENROUTER_API_KEY. Set it, or set ` +
        `JUDGE_MODEL=claude-sonnet-4-6 to judge with Anthropic instead.`,
    );
  }
  return openRouterTextModel({
    apiKey: orKey,
    model: id,
    referer: "https://releases.sh",
    title: "Releases",
    // Tag eval runs so Broadcast traces stay separate from prod traffic.
    trace: { generationName: "rubric-judge-eval", environment: "eval" },
  });
}

/**
 * Run one rubric-judge call and extract the verdict label. `maxTokens` should be
 * generous (>= 2048): an OpenRouter model that emits reasoning tokens can
 * otherwise starve the JSON budget and return empty text → "unparseable".
 */
export async function runJudge(
  model: TextModel,
  prompt: string,
  maxTokens: number,
): Promise<{ result: string; ok: boolean }> {
  const res = await model.complete({ system: "", user: prompt, maxTokens });
  const json = extractJudgeJson(res.text);
  if (json === null) return { result: "unparseable", ok: false };
  try {
    const result = String(JSON.parse(json).result ?? "failed");
    return { result, ok: result === "satisfied" };
  } catch {
    return { result: "unparseable", ok: false };
  }
}
