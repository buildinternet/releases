import { Hono } from "hono";
import { sql, gte, eq } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  usageLog,
  sources,
  USAGE_EXTRACTION_MODES,
  USAGE_FALLBACK_REASONS,
  type UsageExtractionMode,
  type UsageFallbackReason,
} from "@buildinternet/releases-core/schema";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import type { Env } from "../index.js";

function validateExtractionMode(v: unknown): UsageExtractionMode | null {
  return typeof v === "string" && (USAGE_EXTRACTION_MODES as readonly string[]).includes(v)
    ? (v as UsageExtractionMode)
    : null;
}

function validateFallbackReason(v: unknown): UsageFallbackReason | null {
  return typeof v === "string" && (USAGE_FALLBACK_REASONS as readonly string[]).includes(v)
    ? (v as UsageFallbackReason)
    : null;
}

function toIntOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

export const usageLogRoutes = new Hono<Env>();

usageLogRoutes.get("/admin/logs/usage/stats", async (c) => {
  const db = createDb(c.env.DB);
  const days = parseInt(c.req.query("days") ?? "7", 10);
  const since = daysAgoIso(days);

  const [[totals], byOperation, byModel, bySource] = await Promise.all([
    db
      .select({
        totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(usageLog)
      .where(gte(usageLog.createdAt, since)),

    db
      .select({
        label: usageLog.operation,
        totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(usageLog)
      .where(gte(usageLog.createdAt, since))
      .groupBy(usageLog.operation),

    db
      .select({
        label: usageLog.model,
        totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(usageLog)
      .where(gte(usageLog.createdAt, since))
      .groupBy(usageLog.model),

    // Group by source_id (the stable FK) and join sources for the display slug.
    // Rows whose source has been deleted (source_id NULL via ON DELETE SET NULL)
    // are excluded — they still contribute to totals and the by-operation /
    // by-model rollups, just not the per-source breakdown.
    db
      .select({
        label: sources.slug,
        totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(usageLog)
      .innerJoin(sources, eq(usageLog.sourceId, sources.id))
      .where(gte(usageLog.createdAt, since))
      .groupBy(usageLog.sourceId),
  ]);

  return c.json({ totals, byOperation, byModel, bySource });
});

usageLogRoutes.post("/admin/logs/usage", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json();

  // Callers may pass sourceId directly, or sourceSlug for back-compat from
  // before #699 Phase D. When only the slug is supplied, promote it to
  // sourceId only when the lookup is unambiguous — per-org uniqueness (#690)
  // lets the same slug live under multiple orgs, and picking the first match
  // would silently misattribute usage. Ambiguous or unknown slugs land as
  // sourceId NULL; the row still contributes to totals.
  let resolvedSourceId: string | null = body.sourceId ?? null;
  const incomingSlug: string | null = body.sourceSlug ?? null;
  if (!resolvedSourceId && incomingSlug) {
    const matches = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.slug, incomingSlug))
      .limit(2);
    if (matches.length === 1) {
      resolvedSourceId = matches[0]!.id;
    }
  }

  const [inserted] = await db
    .insert(usageLog)
    .values({
      operation: body.operation,
      model: body.model,
      inputTokens: body.inputTokens,
      outputTokens: body.outputTokens,
      sourceId: resolvedSourceId,
      releaseCount: body.releaseCount ?? null,
      extractionMode: validateExtractionMode(body.extractionMode),
      toolRounds: toIntOrNull(body.toolRounds),
      toolChars: toIntOrNull(body.toolChars),
      fallbackReason: validateFallbackReason(body.fallbackReason),
      cacheReadTokens: toIntOrNull(body.cacheReadTokens),
      cacheWriteTokens: toIntOrNull(body.cacheWriteTokens),
    })
    .returning();

  return c.json(inserted, 201);
});
