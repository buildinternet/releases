/**
 * Open, unauthenticated POST /v1/feedback — mirrors /v1/telemetry but carries
 * intentional free text. Persists to D1 and fires a best-effort email via
 * waitUntil. Because it's open + free-text + email-amplifying, it carries its
 * own defenses: a body-size cap, a per-IP rate limiter (kill switch defaults
 * ON), and control-character stripping so stored text can't inject terminal
 * escapes when displayed (operator CLI / future web). The notification email
 * is volume-capped separately in feedback-email.ts.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  feedback,
  FEEDBACK_TYPES,
  FEEDBACK_STATUSES,
  TELEMETRY_CLIENT_KINDS,
} from "@buildinternet/releases-core/schema";
import { newFeedbackId } from "@buildinternet/releases-core/id";
import { createDb } from "../db.js";
import { sanitizeString, sanitizeText, stripControl } from "../lib/sanitize.js";
import { notifyFeedback } from "../lib/feedback-email.js";
import type { Env } from "../index.js";
import { FLAGS, flag } from "@releases/lib/flags";

export const feedbackRoutes = new Hono<Env>();

const MIN_MESSAGE = 5;
const MAX_MESSAGE = 4000;
const MAX_CONTACT = 200;
// The largest fields sum to ~4.3KB; 64KB leaves generous headroom while
// rejecting absurd payloads before we parse them.
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_SECONDS = 60;

// Matches the test-injection pattern in workers/api/src/routes/admin-cron-runs.ts;
// real routes get a fresh drizzle handle, tests inject their own via c.set("db", ...).
function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

function coerceType(v: unknown): string {
  return typeof v === "string" && (FEEDBACK_TYPES as readonly string[]).includes(v) ? v : "general";
}

function coerceClientKind(v: unknown): string {
  return typeof v === "string" && (TELEMETRY_CLIENT_KINDS as readonly string[]).includes(v)
    ? v
    : "external";
}

feedbackRoutes.post("/feedback", async (c) => {
  if (await flag(c.env.FLAGS, c.env.FEEDBACK_DISABLED, FLAGS.feedbackDisabled)) {
    return c.json({ error: "feedback_disabled" }, 503);
  }

  // Reject oversized payloads before reading the body.
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return c.json({ error: "payload_too_large" }, 413);
  }

  // Per-IP rate limit. publicRateLimitMiddleware only covers safe methods, so
  // this open POST needs its own. Kill switch defaults ON (only "false" opts
  // out); no-ops when the binding is absent (e.g. staging, tests without it).
  const limiter =
    c.env.FEEDBACK_RATE_LIMIT_ENABLED !== "false" ? c.env.FEEDBACK_RATE_LIMITER : undefined;
  if (limiter) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await limiter.limit({ key: `feedback:${ip}` });
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
  // JSON literals like `null`, numbers, strings, and arrays parse fine but
  // aren't the object shape we read fields off — guard before access.
  if (typeof parsed !== "object" || parsed === null) {
    return c.json({ error: "invalid_json" }, 400);
  }
  const body = parsed as Record<string, unknown>;

  const rawMessage = sanitizeString(body.message, MAX_MESSAGE);
  const message = rawMessage ? stripControl(rawMessage).trim() : null;
  if (!message || message.length < MIN_MESSAGE) {
    return c.json({ error: "message_required" }, 400);
  }

  const rawContact = sanitizeString(body.contact, MAX_CONTACT);
  const contact = rawContact ? stripControl(rawContact).trim() || null : null;

  const db = getDb(c);
  const row = {
    id: newFeedbackId(),
    createdAt: Date.now(),
    message,
    contact,
    type: coerceType(body.type),
    status: "new",
    archived: false,
    cliVersion: sanitizeText(body.cliVersion, 32),
    clientKind: coerceClientKind(body.clientKind),
    anonId: sanitizeText(body.anonId, 64),
    os: sanitizeText(body.os, 64),
    arch: sanitizeText(body.arch, 64),
    runtime: sanitizeText(body.runtime, 64),
    surface: sanitizeText(body.surface, 32) ?? "cli",
  };

  await db.insert(feedback).values(row);

  c.executionCtx.waitUntil(notifyFeedback(c.env, row));

  return c.json({ ok: true, id: row.id }, 202);
});

// ── Triage write-path (admin-gated) ──
//
// The POST above is open + unauthenticated. Everything under /feedback/:id is
// admin-only — the gate is wired in index.ts (`/feedback/*` → authMiddleware),
// mirroring how the read-back at /v1/admin/feedback is protected. These live on
// the canonical resource path (not a new /v1/admin/* CRUD endpoint) per the
// route conventions in AGENTS.md / #494.

/**
 * PATCH /v1/feedback/:id — partial update of the triage state. Accepts any of:
 *   - `status`: one of FEEDBACK_STATUSES (`new` | `triaged` | `closed`).
 *   - `archived`: boolean. `true` hides the row from the default admin read
 *     path (soft removal, reversible); `false` restores it.
 * At least one field must be present and valid. Returns the updated row, or 404
 * if no feedback matches the id.
 */
feedbackRoutes.patch("/feedback/:id", async (c) => {
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
      !(FEEDBACK_STATUSES as readonly string[]).includes(body.status)
    ) {
      return c.json(
        {
          error: "invalid_status",
          message: `status must be one of: ${FEEDBACK_STATUSES.join(", ")}`,
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
  const [updated] = await db.update(feedback).set(update).where(eq(feedback.id, id)).returning();

  if (!updated) return c.json({ error: "not_found", message: "Feedback not found" }, 404);

  return c.json(updated);
});

/**
 * DELETE /v1/feedback/:id — hard delete. Removes the row entirely; use this for
 * genuine junk (spam, smoke-test rows). For reversible removal that keeps an
 * audit trail, archive via PATCH instead. Returns `{ deleted: true, id }`, or
 * 404 if no feedback matches the id.
 */
feedbackRoutes.delete("/feedback/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);

  const [deleted] = await db
    .delete(feedback)
    .where(eq(feedback.id, id))
    .returning({ id: feedback.id });

  if (!deleted) return c.json({ error: "not_found", message: "Feedback not found" }, 404);

  return c.json({ deleted: true, id: deleted.id });
});
