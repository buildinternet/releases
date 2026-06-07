/**
 * Shared rubric-judge plumbing for the LLM-as-judge eval suites
 * (`release-summary.eval.ts`, `overview.eval.ts`).
 *
 * The judge defaults to Anthropic Sonnet (the baseline), but can be routed
 * through OpenRouter via the provider-agnostic `TextModel` seam by setting
 * `JUDGE_OPENROUTER_MODEL` + `OPENROUTER_API_KEY`. A spike (see PR) found Gemini
 * 2.5 Flash is a ~15x-cheaper, ~4x-faster judge that catches every objective
 * faithfulness violation and emits clean JSON; its only divergence from Sonnet
 * is a stricter reading of subjective "lead-with-the-user-outcome" criteria, so
 * re-baseline pass-rates against it rather than comparing to Sonnet history.
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

/**
 * The judge model under test. Defaults to Anthropic `defaultModel`. Set
 * `JUDGE_OPENROUTER_MODEL` (e.g. "google/gemini-2.5-flash") + `OPENROUTER_API_KEY`
 * to route the judge through OpenRouter instead.
 */
export function resolveJudgeModel(client: Anthropic, defaultModel: string): TextModel {
  const orModel = process.env.JUDGE_OPENROUTER_MODEL?.trim();
  const orKey = process.env.OPENROUTER_API_KEY?.trim();
  if (orModel && orKey) {
    return openRouterTextModel({
      apiKey: orKey,
      model: orModel,
      referer: "https://releases.sh",
      title: "Releases",
      // Tag eval runs so Broadcast traces stay separate from prod traffic.
      trace: { generationName: "rubric-judge-eval", environment: "eval" },
    });
  }
  return anthropicTextModel(client, defaultModel);
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
