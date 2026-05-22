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
import {
  feedback,
  FEEDBACK_TYPES,
  TELEMETRY_CLIENT_KINDS,
} from "@buildinternet/releases-core/schema";
import { newFeedbackId } from "@buildinternet/releases-core/id";
import { createDb } from "../db.js";
import { sanitizeString } from "../lib/sanitize.js";
import { notifyFeedback } from "../lib/feedback-email.js";
import type { Env } from "../index.js";

export const feedbackRoutes = new Hono<Env>();

const MIN_MESSAGE = 5;
const MAX_MESSAGE = 4000;
const MAX_CONTACT = 200;
// The largest fields sum to ~4.3KB; 64KB leaves generous headroom while
// rejecting absurd payloads before we parse them.
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_SECONDS = 60;

// Strip C0/C1 control chars (incl. ESC = 0x1b, which begins ANSI escape
// sequences) except tab (0x09) and newline (0x0a), so stored feedback can't
// inject terminal escapes when an operator views it via `admin feedback list`
// or a future web surface renders it. Char-code filter (not a control-char
// regex literal) keeps raw control bytes out of this source file.
function isControlChar(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false; // allow tab + newline
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}
function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    if (!isControlChar(ch.charCodeAt(0))) out += ch;
  }
  return out;
}

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
  if (c.env.FEEDBACK_DISABLED === "true") {
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
    cliVersion: sanitizeString(body.cliVersion, 32),
    clientKind: coerceClientKind(body.clientKind),
    anonId: sanitizeString(body.anonId, 64),
    os: sanitizeString(body.os, 64),
    arch: sanitizeString(body.arch, 64),
    runtime: sanitizeString(body.runtime, 64),
    surface: sanitizeString(body.surface, 32) ?? "cli",
  };

  await db.insert(feedback).values(row);

  c.executionCtx.waitUntil(notifyFeedback(c.env, row));

  return c.json({ ok: true, id: row.id }, 202);
});
