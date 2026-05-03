import { Hono } from "hono";
import { sql, gte, and, eq } from "drizzle-orm";
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
    // Rows that pre-date the dual-write (source_id IS NULL) fall back to
    // source_slug so the stats endpoint stays useful during the backfill window.
    db
      .select({
        label: sql<string>`COALESCE(${sources.slug}, ${usageLog.sourceSlug})`,
        totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(usageLog)
      .leftJoin(sources, eq(usageLog.sourceId, sources.id))
      .where(
        and(
          gte(usageLog.createdAt, since),
          sql`(${usageLog.sourceId} IS NOT NULL OR ${usageLog.sourceSlug} IS NOT NULL)`,
        ),
      )
      .groupBy(sql`COALESCE(${usageLog.sourceId}, ${usageLog.sourceSlug})`),
  ]);

  return c.json({ totals, byOperation, byModel, bySource });
});

usageLogRoutes.post("/admin/logs/usage", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json();

  // Dual-write: callers supply sourceSlug; resolve to sourceId so new rows
  // carry both. Callers may also supply sourceId directly (future) — if present
  // it wins without a DB round-trip.
  let resolvedSourceId: string | null = body.sourceId ?? null;
  const incomingSlug: string | null = body.sourceSlug ?? null;
  if (!resolvedSourceId && incomingSlug) {
    const [src] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.slug, incomingSlug))
      .limit(1);
    resolvedSourceId = src?.id ?? null;
  }

  const [inserted] = await db
    .insert(usageLog)
    .values({
      operation: body.operation,
      model: body.model,
      inputTokens: body.inputTokens,
      outputTokens: body.outputTokens,
      sourceSlug: incomingSlug,
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
