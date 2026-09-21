/**
 * Operator-editable OpenRouter model ids for the cheap-call AI lanes.
 * Stored as JSON under the `ai_lane_models` key of `site_settings`.
 * Missing / empty keys fall through to the worker's wrangler var.
 */

export const AI_LANE_MODELS_KEY = "ai_lane_models";
/** Decisions API model supported by the marketing lane; not a text-generation model. */
export const MARKETING_DECISION_MODEL = "typesafe/jev-1.13";

export const AI_LANES = ["summarize", "extract", "feed-enrich", "marketing"] as const;
export type AiLane = (typeof AI_LANES)[number];

export type AiLaneModels = Partial<Record<AiLane, string>>;

export const AI_LANE_META: Record<AiLane, { label: string; description: string; envVar: string }> =
  {
    summarize: {
      label: "Summarize",
      description: "Release titles/summaries, collection daily/weekly, org overviews.",
      envVar: "SUMMARIZE_MODEL",
    },
    extract: {
      label: "Extract",
      description: "Changelog body → release records (one-shot and tool-loop).",
      envVar: "EXTRACT_MODEL",
    },
    "feed-enrich": {
      label: "Feed enrich",
      description: "Pull full article text for summary-only RSS/JSON feeds.",
      envVar: "FEED_ENRICH_MODEL",
    },
    marketing: {
      label: "Marketing classifier",
      description: "Filter marketing posts from product-news feeds.",
      envVar: "MARKETING_CLASSIFIER_MODEL",
    },
  };

/** OpenRouter ids: `vendor/model`, optional `~` snapshot prefix, `:variant` suffix. */
export const OPENROUTER_MODEL_ID_RE = /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9._:/-]+$/i;

const MODEL_ID_MAX = 200;

export function isAiLane(value: string): value is AiLane {
  return (AI_LANES as readonly string[]).includes(value);
}

/** Return a trimmed model id, or null if empty/invalid. */
export function parseOpenRouterModelId(raw: string): string | null {
  const id = raw.trim();
  if (!id || id.length > MODEL_ID_MAX) return null;
  return OPENROUTER_MODEL_ID_RE.test(id) ? id : null;
}

export function parseAiLaneModels(raw: string | null | undefined): AiLaneModels {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: AiLaneModels = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isAiLane(key) || typeof value !== "string") continue;
    const id = parseOpenRouterModelId(value);
    if (id) out[key] = id;
  }
  return out;
}

/**
 * Override wins when set; otherwise the wrangler default. Empty wrangler var
 * means "this lane stays on Anthropic" — same as today.
 */
export function applyLaneOverride(
  wranglerDefault: string | undefined,
  override: string | undefined,
): string | undefined {
  const over = override?.trim();
  if (over) return over;
  const fallback = wranglerDefault?.trim();
  return fallback || undefined;
}

export function wranglerVarName(lane: AiLane): string {
  return AI_LANE_META[lane].envVar;
}
