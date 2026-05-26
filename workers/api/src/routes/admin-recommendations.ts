/**
 * Admin-only read-back for recommendations. Gated by authMiddleware via
 * the "admin/recommendations" entry in route-namespaces.ts.
 */
import { Hono } from "hono";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import {
  recommendations,
  RECOMMENDATION_STATUSES,
  RECOMMENDATION_TYPES,
} from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import type { Env } from "../index.js";

export const adminRecommendationRoutes = new Hono<Env>();

function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

function parseLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  return Math.max(1, Math.min(Number.isFinite(n) ? n : 50, 200));
}

function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(`${createdAt}:${id}`).toString("base64url");
}

function decodeCursor(raw: string | undefined): { createdAt: number; id: string } | null {
  if (!raw) return null;
  try {
    const [ts, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split(":");
    const createdAt = parseInt(ts ?? "", 10);
    const id = rest.join(":");
    if (!Number.isFinite(createdAt) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

adminRecommendationRoutes.get("/admin/recommendations", async (c) => {
  const db = getDb(c);
  const limit = parseLimit(c.req.query("limit"));
  const conditions: SQL[] = [];

  const status = c.req.query("status");
  if (status && (RECOMMENDATION_STATUSES as readonly string[]).includes(status)) {
    conditions.push(eq(recommendations.status, status));
  }
  const type = c.req.query("type");
  if (type && (RECOMMENDATION_TYPES as readonly string[]).includes(type)) {
    conditions.push(eq(recommendations.type, type));
  }
  if (c.req.query("includeArchived") !== "true") {
    conditions.push(eq(recommendations.archived, false));
  }

  const cursor = decodeCursor(c.req.query("cursor"));
  if (cursor) {
    conditions.push(
      or(
        lt(recommendations.createdAt, cursor.createdAt),
        and(eq(recommendations.createdAt, cursor.createdAt), lt(recommendations.id, cursor.id)),
      )!,
    );
  }

  const rows = await db
    .select()
    .from(recommendations)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(recommendations.createdAt), desc(recommendations.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return c.json({ items, nextCursor });
});
