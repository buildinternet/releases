/**
 * Runtime overlay of operator-picked OpenRouter model ids on top of wrangler
 * vars. Stored in `site_settings` (`ai_lane_models`); missing keys fall through
 * to the var. Isolate-local cache so ingest doesn't hit D1 on every summarize.
 */
import {
  AI_LANES,
  MARKETING_DECISION_MODEL,
  AI_LANE_META,
  applyLaneOverride,
  parseOpenRouterModelId,
  type AiLane,
  type AiLaneModels,
} from "@releases/core-internal/ai-lane-models";
import type { OpenRouterCatalogModel } from "@buildinternet/releases-api-types";
import { createDb, type AnyDb } from "../../db.js";
import { getStoredAiLaneModels } from "../../queries/site-settings.js";
import { getSecret, type SecretBinding } from "@releases/lib/secrets";
import { logEvent } from "@releases/lib/log-event";

const OVERLAY_TTL_MS = 30_000;
const CATALOG_TTL_MS = 10 * 60_000;

let overlayCache: { at: number; models: AiLaneModels } | null = null;
let catalogCache: {
  at: number;
  catalog: OpenRouterCatalogModel[];
  fetchedAt: string;
} | null = null;

// The text-only catalog excludes JEV. Keep the supported decision model available
// even when catalog fetching fails; unknown pricing stays unknown.
const DECISION_CATALOG: OpenRouterCatalogModel = {
  id: MARKETING_DECISION_MODEL,
  name: "Typesafe: JEV 1.13 (decision)",
  contextLength: null,
  promptPricePerMillion: null,
  completionPricePerMillion: null,
  vision: false,
};

export function clearAiLaneModelCache(): void {
  overlayCache = null;
  catalogCache = null;
}

export interface LaneModelEnv {
  DB?: D1Database | AnyDb;
  SUMMARIZE_MODEL?: string;
  EXTRACT_MODEL?: string;
  FEED_ENRICH_MODEL?: string;
  MARKETING_CLASSIFIER_MODEL?: string;
  OPENROUTER_API_KEY?: SecretBinding;
  OPENROUTER_BASE_URL?: string;
}

export function wranglerDefaultForLane(env: LaneModelEnv, lane: AiLane): string | undefined {
  switch (lane) {
    case "summarize":
      return env.SUMMARIZE_MODEL;
    case "extract":
      return env.EXTRACT_MODEL;
    case "feed-enrich":
      return env.FEED_ENRICH_MODEL;
    case "marketing":
      return env.MARKETING_CLASSIFIER_MODEL;
  }
}

export async function loadAiLaneOverrides(db: LaneModelEnv["DB"]): Promise<AiLaneModels> {
  if (!db) return overlayCache?.models ?? {};
  if (overlayCache && Date.now() - overlayCache.at < OVERLAY_TTL_MS) {
    return overlayCache.models;
  }
  try {
    const stored = await getStoredAiLaneModels(createDb(db as D1Database));
    overlayCache = { at: Date.now(), models: stored.models };
    return stored.models;
  } catch (err) {
    logEvent("warn", {
      component: "ai-lane-models",
      event: "overlay-load-failed",
      err: err instanceof Error ? err : String(err),
    });
    return overlayCache?.models ?? {};
  }
}

/** Effective OpenRouter model id for a lane (override, else wrangler, else unset). */
export async function effectiveLaneModel(
  env: LaneModelEnv,
  lane: AiLane,
): Promise<string | undefined> {
  const overrides = await loadAiLaneOverrides(env.DB);
  return applyLaneOverride(wranglerDefaultForLane(env, lane), overrides[lane]);
}

export async function buildLaneStates(env: LaneModelEnv): Promise<{
  lanes: Array<{
    id: AiLane;
    label: string;
    description: string;
    envVar: string;
    wranglerDefault: string | null;
    override: string | null;
    effective: string | null;
  }>;
  updatedAt: string | null;
}> {
  let updatedAt: string | null = null;
  let overrides: AiLaneModels = {};
  if (env.DB) {
    try {
      const stored = await getStoredAiLaneModels(createDb(env.DB as D1Database));
      overrides = stored.models;
      updatedAt = stored.updatedAt;
      overlayCache = { at: Date.now(), models: stored.models };
    } catch (err) {
      logEvent("warn", {
        component: "ai-lane-models",
        event: "overlay-load-failed",
        err: err instanceof Error ? err : String(err),
      });
    }
  }
  return {
    updatedAt,
    lanes: AI_LANES.map((id) => {
      const wranglerDefault = wranglerDefaultForLane(env, id)?.trim() || null;
      const override = overrides[id] ?? null;
      return {
        id,
        label: AI_LANE_META[id].label,
        description: AI_LANE_META[id].description,
        envVar: AI_LANE_META[id].envVar,
        wranglerDefault,
        override,
        effective: applyLaneOverride(wranglerDefault ?? undefined, override ?? undefined) ?? null,
      };
    }),
  };
}

function toPerMillion(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

function parseCatalog(payload: unknown): OpenRouterCatalogModel[] {
  if (typeof payload !== "object" || payload === null) return [DECISION_CATALOG];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [DECISION_CATALOG];
  const out: OpenRouterCatalogModel[] = [];
  for (const row of data) {
    if (typeof row !== "object" || row === null) continue;
    const rec = row as Record<string, unknown>;
    if (typeof rec.id !== "string" || !parseOpenRouterModelId(rec.id)) continue;
    const arch = rec.architecture as { input_modalities?: unknown } | undefined;
    const modalities = Array.isArray(arch?.input_modalities) ? arch.input_modalities : [];
    const pricing = rec.pricing as { prompt?: unknown; completion?: unknown } | undefined;
    out.push({
      id: rec.id,
      name: typeof rec.name === "string" && rec.name.trim() ? rec.name : rec.id,
      contextLength: typeof rec.context_length === "number" ? rec.context_length : null,
      promptPricePerMillion: toPerMillion(pricing?.prompt),
      completionPricePerMillion: toPerMillion(pricing?.completion),
      vision: modalities.includes("image"),
    });
  }
  if (!out.some((m) => m.id === MARKETING_DECISION_MODEL)) out.push(DECISION_CATALOG);
  out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return out;
}

export async function fetchOpenRouterCatalog(env: LaneModelEnv): Promise<{
  catalog: OpenRouterCatalogModel[];
  catalogFetchedAt: string | null;
  catalogError: string | null;
}> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return {
      catalog: catalogCache.catalog,
      catalogFetchedAt: catalogCache.fetchedAt,
      catalogError: null,
    };
  }
  const key = await getSecret(env.OPENROUTER_API_KEY).catch(() => null);
  const base = (env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(
    /\/$/,
    "",
  );
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const res = await fetch(`${base}/models?output_modalities=text`, {
      headers,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const err = `OpenRouter catalog ${res.status}`;
      logEvent("warn", {
        component: "ai-lane-models",
        event: "catalog-fetch-failed",
        status: res.status,
      });
      return {
        catalog: catalogCache?.catalog ?? [DECISION_CATALOG],
        catalogFetchedAt: catalogCache?.fetchedAt ?? null,
        catalogError: err,
      };
    }
    const catalog = parseCatalog(await res.json());
    const fetchedAt = new Date().toISOString();
    catalogCache = { at: Date.now(), catalog, fetchedAt };
    return { catalog, catalogFetchedAt: fetchedAt, catalogError: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent("warn", {
      component: "ai-lane-models",
      event: "catalog-fetch-failed",
      err: message,
    });
    return {
      catalog: catalogCache?.catalog ?? [DECISION_CATALOG],
      catalogFetchedAt: catalogCache?.fetchedAt ?? null,
      catalogError: message,
    };
  }
}
