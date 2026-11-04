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
import { respondError } from "../lib/error-response.js";
import {
  PayloadTooLargeError,
  RateLimitedError,
  ValidationError,
} from "@releases/lib/releases-error";

export const telemetryRoutes = new Hono<Env>();

const MAX_STRING = 200;
const MAX_COMMAND = 120;
/** A telemetry event is a handful of short fields; anything bigger is not one. */
export const MAX_TELEMETRY_BODY_BYTES = 4096;
const RATE_LIMIT_WINDOW_SECONDS = 60;

function sanitizeClientKind(v: unknown): string {
  if (typeof v !== "string") return "external";
  return (TELEMETRY_CLIENT_KINDS as readonly string[]).includes(v) ? v : "external";
}

function sanitizeSurface(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return (TELEMETRY_SURFACES as readonly string[]).includes(v) ? v : null;
}

telemetryRoutes.post("/telemetry", async (c) => {
  // Anonymous and open, so bound both the rate and the size of what one
  // client can write into telemetry_events.
  const limiter = c.env.TELEMETRY_RATE_LIMITER;
  if (limiter) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await limiter.limit({ key: `telemetry:${ip}` });
    if (!success) {
      c.header("Retry-After", String(RATE_LIMIT_WINDOW_SECONDS));
      return respondError(c, new RateLimitedError("Too many telemetry events. Retry shortly."));
    }
  }

  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_TELEMETRY_BODY_BYTES) {
    return respondError(c, new PayloadTooLargeError("Telemetry event too large"));
  }
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_TELEMETRY_BODY_BYTES) {
    return respondError(c, new PayloadTooLargeError("Telemetry event too large"));
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return respondError(c, new ValidationError(undefined, { code: "invalid_json" }));
  }

  const surface = sanitizeSurface(body.surface);
  const command = sanitizeString(body.command, MAX_COMMAND);
  const anonId = sanitizeString(body.anonId, 64);
  const cliVersion = sanitizeString(body.cliVersion, 32);
  const timestamp = sanitizeInt(body.timestamp) ?? Date.now();

  if (!surface || !command || !anonId || !cliVersion) {
    return respondError(c, new ValidationError(undefined, { code: "bad_request" }));
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
