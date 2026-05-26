/**
 * Open, unauthenticated POST /v1/recommendations. Stores typed
 * recommendations and sends a best-effort operator email.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  recommendations,
  RECOMMENDATION_STATUSES,
  RECOMMENDATION_TYPES,
} from "@buildinternet/releases-core/schema";
import { newRecommendationId } from "@buildinternet/releases-core/id";
import { createDb } from "../db.js";
import { sanitizeString } from "../lib/sanitize.js";
import { notifyRecommendation } from "../lib/recommendation-email.js";
import type { Env } from "../index.js";

export const recommendationRoutes = new Hono<Env>();

const MAX_URL = 2048;
const MAX_NOTE = 4000;
const MAX_CONTACT_EMAIL = 200;
const MAX_USER_AGENT = 500;
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isControlChar(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    if (!isControlChar(ch.charCodeAt(0))) out += ch;
  }
  return out;
}

function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

function normalizeSubmittedUrl(raw: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseRecommendationType(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return "source";
  return typeof v === "string" && (RECOMMENDATION_TYPES as readonly string[]).includes(v)
    ? v
    : null;
}

recommendationRoutes.post("/recommendations", async (c) => {
  if (c.env.RECOMMENDATIONS_DISABLED === "true") {
    return c.json({ error: "recommendations_disabled" }, 503);
  }

  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return c.json({ error: "payload_too_large" }, 413);
  }

  const limiter =
    c.env.FEEDBACK_RATE_LIMIT_ENABLED !== "false" ? c.env.FEEDBACK_RATE_LIMITER : undefined;
  if (limiter) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await limiter.limit({ key: `recommendation:${ip}` });
    if (!success) {
      c.header("Retry-After", String(RATE_LIMIT_WINDOW_SECONDS));
      return c.json(
        { error: "rate_limited", message: "Too many requests. Please retry shortly." },
        429,
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return c.json({ error: "invalid_json" }, 400);
  }
  const body = parsed as Record<string, unknown>;
  const type = parseRecommendationType(body.type);
  if (!type) {
    return c.json(
      {
        error: "invalid_type",
        message: `type must be one of: ${RECOMMENDATION_TYPES.join(", ")}`,
      },
      400,
    );
  }

  const rawUrl = sanitizeString(body.url, MAX_URL);
  const submittedUrl = rawUrl ? stripControl(rawUrl).trim() : null;
  const url = submittedUrl ? normalizeSubmittedUrl(submittedUrl) : null;
  if (!url) {
    return c.json({ error: "url_required", message: "Provide a valid http(s) URL." }, 400);
  }

  const rawNote = sanitizeString(body.note ?? body.additionalInfo, MAX_NOTE);
  const note = rawNote ? stripControl(rawNote).trim() || null : null;

  const rawContact = sanitizeString(body.contactEmail ?? body.email, MAX_CONTACT_EMAIL);
  const contactEmail = rawContact ? stripControl(rawContact).trim() || null : null;
  if (contactEmail && !EMAIL_PATTERN.test(contactEmail)) {
    return c.json({ error: "invalid_email", message: "Provide a valid email address." }, 400);
  }

  const row = {
    id: newRecommendationId(),
    createdAt: Date.now(),
    type,
    url,
    note,
    contactEmail,
    status: "new",
    archived: false,
    surface: sanitizeString(body.surface, 32) ?? "web",
    userAgent: sanitizeString(c.req.header("user-agent"), MAX_USER_AGENT),
  };

  const db = getDb(c);
  await db.insert(recommendations).values(row);

  c.executionCtx.waitUntil(notifyRecommendation(c.env, row));

  return c.json({ ok: true, id: row.id }, 202);
});

recommendationRoutes.patch("/recommendations/:id", async (c) => {
  const id = c.req.param("id");

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return c.json({ error: "invalid_json" }, 400);
  }
  const body = parsed as Record<string, unknown>;

  const update: { status?: string; archived?: boolean } = {};
  if (body.status !== undefined) {
    if (
      typeof body.status !== "string" ||
      !(RECOMMENDATION_STATUSES as readonly string[]).includes(body.status)
    ) {
      return c.json(
        {
          error: "invalid_status",
          message: `status must be one of: ${RECOMMENDATION_STATUSES.join(", ")}`,
        },
        400,
      );
    }
    update.status = body.status;
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") {
      return c.json({ error: "invalid_archived", message: "archived must be a boolean" }, 400);
    }
    update.archived = body.archived;
  }
  if (update.status === undefined && update.archived === undefined) {
    return c.json({ error: "nothing_to_update", message: "provide status and/or archived" }, 400);
  }

  const db = getDb(c);
  const [updated] = await db
    .update(recommendations)
    .set(update)
    .where(eq(recommendations.id, id))
    .returning();

  if (!updated) return c.json({ error: "not_found", message: "Recommendation not found" }, 404);
  return c.json(updated);
});

recommendationRoutes.delete("/recommendations/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  const [deleted] = await db
    .delete(recommendations)
    .where(eq(recommendations.id, id))
    .returning({ id: recommendations.id });

  if (!deleted) return c.json({ error: "not_found", message: "Recommendation not found" }, 404);
  return c.json({ deleted: true, id: deleted.id });
});
