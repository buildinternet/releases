/**
 * Admin semantic-alerts preview (#2304).
 *
 * `POST /preview` inserts synthetic changelog rows through the real batch
 * ingest path (D1 upsert, then `publishReleaseEvents` + webhook fanout).
 * `POST /purge` deletes rows flagged `metadata.semanticAlertDemo`.
 *
 * Auth is the `admin/semantic-alerts` entry in `adminRoutes` (`authMiddleware`,
 * admin scope or root). This file does not re-check the bearer.
 */
import { Hono } from "hono";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { respondError } from "../lib/error-response.js";
import { ValidationError } from "@releases/lib/releases-error";
import {
  SEMANTIC_ALERT_DEMO_DEFAULT_COUNT,
  SEMANTIC_ALERT_DEMO_MAX_COUNT,
  purgeSemanticAlertDemoReleases,
  runSemanticAlertPreview,
} from "../lib/semantic-alert-demo.js";

export const adminSemanticAlertsRoutes = new Hono<Env>();

function parseCount(value: unknown): number {
  if (value === undefined) return SEMANTIC_ALERT_DEMO_DEFAULT_COUNT;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError(
      `count must be an integer from 1 to ${SEMANTIC_ALERT_DEMO_MAX_COUNT}`,
      {
        code: "bad_request",
        details: { max: SEMANTIC_ALERT_DEMO_MAX_COUNT },
      },
    );
  }
  if (value < 1 || value > SEMANTIC_ALERT_DEMO_MAX_COUNT) {
    throw new ValidationError(
      `count must be an integer from 1 to ${SEMANTIC_ALERT_DEMO_MAX_COUNT}`,
      {
        code: "bad_request",
        details: { max: SEMANTIC_ALERT_DEMO_MAX_COUNT },
      },
    );
  }
  return value;
}

function parseOptionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`, { code: "bad_request" });
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters`, {
      code: "bad_request",
    });
  }
  return trimmed;
}

adminSemanticAlertsRoutes.post("/admin/semantic-alerts/preview", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return respondError(
      c,
      new ValidationError("JSON object body required", { code: "bad_request" }),
    );
  }

  try {
    const count = parseCount(body.count);
    const sourceRef = parseOptionalString(body.sourceId, "sourceId", 200);
    const userId = parseOptionalString(body.userId, "userId", 128);
    const seed = parseOptionalString(body.seed, "seed", 64);
    const db = createDb(c.env.DB);
    const result = await runSemanticAlertPreview(db, c.env, {
      count,
      ...(sourceRef ? { sourceRef } : {}),
      ...(userId ? { userId } : {}),
      ...(seed ? { seed } : {}),
    });
    c.header("cache-control", "private, no-store");
    return c.json(result);
  } catch (err) {
    return respondError(c, err);
  }
});

adminSemanticAlertsRoutes.post("/admin/semantic-alerts/purge", async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return respondError(
      c,
      new ValidationError("JSON object body required", { code: "bad_request" }),
    );
  }
  if (body.all !== undefined && typeof body.all !== "boolean") {
    return respondError(c, new ValidationError("all must be a boolean", { code: "bad_request" }));
  }

  try {
    const sourceRef = parseOptionalString(body.sourceId, "sourceId", 200);
    const db = createDb(c.env.DB);
    const result = await purgeSemanticAlertDemoReleases(db, {
      ...(sourceRef ? { sourceRef } : {}),
      ...(body.all === true ? { all: true } : {}),
    });
    c.header("cache-control", "private, no-store");
    return c.json(result);
  } catch (err) {
    return respondError(c, err);
  }
});
