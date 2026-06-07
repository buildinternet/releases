/**
 * Shared rubric-judge plumbing for the LLM-as-judge eval suites
 * (`release-summary.eval.ts`, `overview.eval.ts`).
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
import type Anthropic from "@anthropic-ai/sdk";
import {
  anthropicTextModel,
  openRouterTextModel,
  type TextModel,
} from "@releases/ai-internal/text-model";

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

/** Default judge: a cheap OpenRouter model. Override with the `JUDGE_MODEL` env var. */
export const DEFAULT_JUDGE_MODEL = "google/gemini-2.5-flash";

/**
 * Resolve the judge model. Defaults to {@link DEFAULT_JUDGE_MODEL} on OpenRouter;
 * `JUDGE_MODEL` overrides it. An `claude-…` id routes through the Anthropic SDK;
 * any other id is an OpenRouter slug (requires `OPENROUTER_API_KEY`).
 */
export function resolveJudgeModel(client: Anthropic): TextModel {
  const id = process.env.JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL;
  if (id.startsWith("claude")) {
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
