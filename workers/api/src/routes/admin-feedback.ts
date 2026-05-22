/**
 * Admin-only read-back for submitted feedback. Gated by authMiddleware via the
 * "admin/feedback" entry in route-namespaces.ts. Cursor-paginated, newest
 * first; optional ?status= and ?type= filters.
 */
import { Hono } from "hono";
import { and, eq, or, lt, desc, type SQL } from "drizzle-orm";
import { feedback, FEEDBACK_TYPES } from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import type { Env } from "../index.js";

export const adminFeedbackRoutes = new Hono<Env>();

const FEEDBACK_STATUSES = ["new", "triaged", "closed"] as const;

// Matches the test-injection pattern in workers/api/src/routes/admin-cron-runs.ts;
// real routes get a fresh drizzle handle, tests inject their own via c.set("db", ...).
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

adminFeedbackRoutes.get("/admin/feedback", async (c) => {
  const db = getDb(c);
  const limit = parseLimit(c.req.query("limit"));

  const status = c.req.query("status");
  const type = c.req.query("type");
  const conditions: SQL[] = [];
  if (status && (FEEDBACK_STATUSES as readonly string[]).includes(status)) {
    conditions.push(eq(feedback.status, status));
  }
  if (type && (FEEDBACK_TYPES as readonly string[]).includes(type)) {
    conditions.push(eq(feedback.type, type));
  }

  const cursor = decodeCursor(c.req.query("cursor"));
  if (cursor) {
    // (createdAt, id) strictly less than the cursor — newest-first paging.
    conditions.push(
      or(
        lt(feedback.createdAt, cursor.createdAt),
        and(eq(feedback.createdAt, cursor.createdAt), lt(feedback.id, cursor.id)),
      )!,
    );
  }

  const rows = await db
    .select()
    .from(feedback)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(feedback.createdAt), desc(feedback.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return c.json({ items, nextCursor });
});
