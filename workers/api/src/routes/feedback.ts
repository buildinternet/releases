/**
 * Open, unauthenticated POST /v1/feedback — mirrors /v1/telemetry but carries
 * intentional free text. Mounted in v1-routes.ts; rate-limited + kill-switched
 * in index.ts. Persists to D1 and fires a best-effort email via waitUntil.
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

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const message = sanitizeString(body.message, MAX_MESSAGE);
  if (!message || message.length < MIN_MESSAGE) {
    return c.json({ error: "message_required" }, 400);
  }

  const db = getDb(c);
  const row = {
    id: newFeedbackId(),
    createdAt: Date.now(),
    message,
    contact: sanitizeString(body.contact, MAX_CONTACT),
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
