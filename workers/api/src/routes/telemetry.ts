import { Hono } from "hono";
import { createDb } from "../db.js";
import {
  telemetryEvents,
  TELEMETRY_CLIENT_KINDS,
  TELEMETRY_SURFACES,
} from "@buildinternet/releases-core/schema";
import { newTelemetryEventId } from "@buildinternet/releases-core/id";
import { sanitizeString, sanitizeInt } from "../lib/sanitize.js";
import type { Env } from "../index.js";

export const telemetryRoutes = new Hono<Env>();

const MAX_STRING = 200;
const MAX_COMMAND = 120;

function sanitizeClientKind(v: unknown): string {
  if (typeof v !== "string") return "external";
  return (TELEMETRY_CLIENT_KINDS as readonly string[]).includes(v) ? v : "external";
}

function sanitizeSurface(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return (TELEMETRY_SURFACES as readonly string[]).includes(v) ? v : null;
}

telemetryRoutes.post("/telemetry", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const surface = sanitizeSurface(body.surface);
  const command = sanitizeString(body.command, MAX_COMMAND);
  const anonId = sanitizeString(body.anonId, 64);
  const cliVersion = sanitizeString(body.cliVersion, 32);
  const timestamp = sanitizeInt(body.timestamp) ?? Date.now();

  if (!surface || !command || !anonId || !cliVersion) {
    return c.json({ error: "missing_required_fields" }, 400);
  }

  const db = createDb(c.env.DB);
  await db.insert(telemetryEvents).values({
    id: newTelemetryEventId(),
    anonId,
    timestamp,
    surface,
    clientKind: sanitizeClientKind(body.clientKind),
    sessionId: sanitizeString(body.sessionId, 64),
    agentName: sanitizeString(body.agentName, 64),
    model: sanitizeString(body.model, 64),
    command,
    exitCode: sanitizeInt(body.exitCode),
    durationMs: sanitizeInt(body.durationMs),
    cliVersion,
    os: sanitizeString(body.os, MAX_STRING),
    arch: sanitizeString(body.arch, MAX_STRING),
    runtime: sanitizeString(body.runtime, MAX_STRING),
  });

  return c.json({ ok: true }, 202);
});
