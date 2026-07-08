/**
 * Shared eval-model plumbing for the local eval suites: the cross-provider
 * "model under test" resolver ({@link resolveEvalModel}) used by the model-comparison
 * evals (`marketing-classifier`, `release-summary`, `article-extract`), and the
 * LLM-as-judge helpers ({@link resolveJudgeModel} / {@link runJudge}) used by the
 * rubric-judged suites (`release-summary.eval.ts`, `overview.eval.ts`). Both build
 * a provider-agnostic `TextModel` from env — OpenRouter when a candidate model is
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
import { buildLaneOpenRouterModel, buildLaneAnthropicModel } from "@releases/adapters/lane-model";
import { aisdkTextModel } from "@releases/ai-internal/aisdk-text-model";
import type { TextModel } from "@releases/ai-internal/text-model";
import type { LanguageModel } from "ai";

const EVAL_REFERER = "https://releases.sh";
const EVAL_TITLE = "Releases";
const EVAL_ENV = "eval";

export interface EvalLaneOptions {
  /** Anthropic model id used as the production-baseline default (the eval's `MODEL`). */
  anthropicModel: string;
  /** Broadcast trace tag (`generationName`) distinguishing this eval's OpenRouter runs. */
  generationName: string;
  /** Env var naming the OpenRouter candidate model — `EVAL_MODEL` or `EVAL_OPENROUTER_MODEL`. */
  orModelEnvVar: string;
}

/** @deprecated Alias for {@link EvalLaneOptions}. */
export type EvalModelOptions = EvalLaneOptions;

function evalLabel(provider: "openrouter" | "anthropic", model: string): string {
  return `${provider}:${model}`;
}

function openRouterEvalLane(model: string, generationName: string): LanguageModel | null {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  const baseURL = process.env.OPENROUTER_BASE_URL?.trim();
  return buildLaneOpenRouterModel({
    apiKey,
    model,
    ...(baseURL ? { baseURL } : {}),
    sessionId: generationName,
    referer: EVAL_REFERER,
    title: EVAL_TITLE,
    trace: { generationName, environment: EVAL_ENV },
  });
}

function anthropicEvalLane(model: string): LanguageModel | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return buildLaneAnthropicModel({ apiKey, model });
}

function asEvalTextModel(lane: LanguageModel, label: string): TextModel {
  return aisdkTextModel(lane, label);
}

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

/**
 * Resolve the cross-provider "model under test" for a local eval. Defaults to
 * the production-baseline Anthropic model; when `OPENROUTER_API_KEY` + the named
 * OpenRouter model env var are both set, evaluates that OpenRouter candidate
 * against the same prompt + fixtures (`OPENROUTER_BASE_URL` optionally routes
 * through an AI Gateway sub-path). The returned `label` matches `model.id`.
 * Returns null when no provider key is available — the caller skips the run.
 */
export function resolveEvalModel(
  opts: EvalLaneOptions,
): { model: TextModel; label: string } | null {
  const orModel = process.env[opts.orModelEnvVar]?.trim();
  if (orModel) {
    const lane = openRouterEvalLane(orModel, opts.generationName);
    if (lane) {
      const label = evalLabel("openrouter", orModel);
      return { model: asEvalTextModel(lane, label), label };
    }
  }
  const lane = anthropicEvalLane(opts.anthropicModel);
  if (lane) {
    const label = evalLabel("anthropic", opts.anthropicModel);
    return { model: asEvalTextModel(lane, label), label };
  }
  return null;
}

/**
 * Resolve the "model under test" for the org-overview eval. UNLIKE
 * {@link resolveEvalModel} (which returns the provider-agnostic `TextModel` the
 * other evals grade), the overview lane runs through the AI SDK structured-output
 * path (`generateText` + `Output.object`), so `generateOverview` needs an AI SDK
 * `LanguageModel`. Mirrors production `resolveOverviewModel`
 * (`workers/api/src/lib/text-model.ts`). Returns null when no provider is usable.
 */
export function resolveOverviewEvalModel(
  opts: EvalLaneOptions,
): { model: LanguageModel; label: string } | null {
  const orModel = process.env[opts.orModelEnvVar]?.trim();
  if (orModel) {
    const lane = openRouterEvalLane(orModel, opts.generationName);
    if (lane) return { model: lane, label: evalLabel("openrouter", orModel) };
  }
  const lane = anthropicEvalLane(opts.anthropicModel);
  if (lane) return { model: lane, label: evalLabel("anthropic", opts.anthropicModel) };
  return null;
}

/** Default judge: a cheap OpenRouter model. Override with the `JUDGE_MODEL` env var. */
export const DEFAULT_JUDGE_MODEL = "google/gemini-2.5-flash";

/**
 * Resolve the judge model. Defaults to {@link DEFAULT_JUDGE_MODEL} on OpenRouter;
 * `JUDGE_MODEL` overrides it. A `claude-…` id routes through Anthropic; any other
 * id is an OpenRouter slug (requires `OPENROUTER_API_KEY`).
 */
export function resolveJudgeModel(): TextModel {
  const id = process.env.JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL;
  if (id.startsWith("claude-")) {
    const lane = anthropicEvalLane(id);
    if (!lane) {
      throw new Error(
        `Judge model "${id}" needs ANTHROPIC_API_KEY. Set it, or pick an OpenRouter judge instead.`,
      );
    }
    return asEvalTextModel(lane, evalLabel("anthropic", id));
  }
  const lane = openRouterEvalLane(id, "rubric-judge-eval");
  if (!lane) {
    throw new Error(
      `Judge model "${id}" needs OPENROUTER_API_KEY. Set it, or set ` +
        `JUDGE_MODEL=claude-sonnet-4-6 to judge with Anthropic instead.`,
    );
  }
  return asEvalTextModel(lane, evalLabel("openrouter", id));
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
