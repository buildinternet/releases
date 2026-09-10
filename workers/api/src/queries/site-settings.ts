import { eq } from "drizzle-orm";
import {
  SITE_NOTICE_KEY,
  type SiteNotice,
  type StoredSiteNotice,
} from "@buildinternet/releases-core/site-notice";
import {
  AI_LANE_MODELS_KEY,
  parseAiLaneModels,
  type AiLaneModels,
} from "@releases/core-internal/ai-lane-models";
import type { AnyDb } from "../db.js";
import { siteSettings } from "../db/schema-site-settings.js";

/** Read a raw setting value by key, or null when unset. */
export async function getSetting(db: AnyDb, key: string): Promise<string | null> {
  const row = await db.select().from(siteSettings).where(eq(siteSettings.key, key)).get();
  return row?.value ?? null;
}

/** Upsert a raw setting value, stamping `updated_at` to now. */
export async function setSetting(db: AnyDb, key: string, value: string): Promise<Date> {
  const now = new Date();
  await db
    .insert(siteSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: now } });
  return now;
}

/**
 * Read the stored site notice (+updatedAt), or null when unset or unparseable.
 * Fail-safe: malformed JSON yields null, never throws.
 */
export async function getStoredSiteNotice(db: AnyDb): Promise<StoredSiteNotice | null> {
  const row = await db
    .select()
    .from(siteSettings)
    .where(eq(siteSettings.key, SITE_NOTICE_KEY))
    .get();
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return { ...(parsed as SiteNotice), updatedAt: row.updatedAt.toISOString() };
}

/** Persist the site notice as JSON and return it stamped with the new updatedAt. */
export async function putStoredSiteNotice(
  db: AnyDb,
  notice: SiteNotice,
): Promise<StoredSiteNotice> {
  const now = await setSetting(db, SITE_NOTICE_KEY, JSON.stringify(notice));
  return { ...notice, updatedAt: now.toISOString() };
}

export interface StoredAiLaneModels {
  models: AiLaneModels;
  updatedAt: string | null;
}

/** Read operator OpenRouter-model overrides, or `{ models: {} }` when unset. */
export async function getStoredAiLaneModels(db: AnyDb): Promise<StoredAiLaneModels> {
  const row = await db
    .select()
    .from(siteSettings)
    .where(eq(siteSettings.key, AI_LANE_MODELS_KEY))
    .get();
  if (!row) return { models: {}, updatedAt: null };
  return {
    models: parseAiLaneModels(row.value),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Persist the overlay map (only lanes with an override) and return it stamped. */
export async function putStoredAiLaneModels(
  db: AnyDb,
  models: AiLaneModels,
): Promise<StoredAiLaneModels> {
  const now = await setSetting(db, AI_LANE_MODELS_KEY, JSON.stringify(models));
  return { models, updatedAt: now.toISOString() };
}
