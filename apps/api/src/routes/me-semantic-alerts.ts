/**
 * Self-serve semantic alert routes at `/v1/me/semantic-alerts`.
 *
 * #2304: store the freeform interest and delivery preferences. Matching and
 * delivery run from publish, not from these routes. Query text is
 * user-private — do not log it and do not write it to Analytics Engine.
 *
 * Gated like follows: production mounts these handlers behind
 * `requireFollowsPrincipal` (session or user Bearer). Handlers still check
 * the session so unit tests can inject one. `semantic-alerts-enabled` off
 * answers 404 after that check.
 */
import { Hono, type Context } from "hono";
import { describeRoute } from "hono-openapi";
import {
  SEMANTIC_ALERT_CANDIDATE_POOL,
  SEMANTIC_ALERT_MAX_PER_USER,
  SEMANTIC_ALERT_QUERY_MAX_CHARS,
  SEMANTIC_ALERT_THRESHOLD_DEFAULT,
  SEMANTIC_ALERT_THRESHOLD_MAX,
  SEMANTIC_ALERT_THRESHOLD_MIN,
  type SemanticAlertListResponse,
} from "@buildinternet/releases-api-types";
import { FLAGS, flag } from "@releases/lib/flags";
import {
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from "@releases/lib/releases-error";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { respondError } from "../lib/error-response.js";
import { errorResponse } from "../lib/openapi-error.js";
import {
  countSemanticAlerts,
  deleteSemanticAlert,
  getSemanticAlert,
  insertSemanticAlert,
  listSemanticAlerts,
  toSemanticAlert,
  updateSemanticAlert,
  userOwnsWebhookSubscription,
  type NewSemanticAlertInput,
  type SemanticAlertPatch,
} from "../queries/semantic-alerts.js";

export const meSemanticAlertHandlers = new Hono<Env>();

const LANE_DESCRIPTION =
  "Signed-in semantic alerts (#2304). Stores a freeform interest and email/webhook preferences. Matching runs after release.created for releases already on the caller's follow graph: one JEV decision per release, one question per enabled alert, notify when the matches-interest probability is at least the alert threshold (default 0.80, allowed 0.50–1.00). At most 5 alerts per account. Query text is user-private and is never written to Analytics Engine. Requires a Better Auth session or a user Bearer token (`relu_` or OAuth JWT); machine `relk_` tokens and anonymous callers are refused. Returns 404 when `semantic-alerts-enabled` is off.";

const alertSchema = {
  type: "object",
  required: [
    "id",
    "query",
    "enabled",
    "threshold",
    "deliverEmail",
    "deliverWebhook",
    "webhookSubscriptionId",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", description: "Typed id, `sal_` prefix." },
    query: { type: "string", description: "Freeform interest. User-private." },
    enabled: { type: "boolean" },
    threshold: { type: "number", minimum: 0.5, maximum: 1 },
    deliverEmail: { type: "boolean" },
    deliverWebhook: { type: "boolean" },
    webhookSubscriptionId: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const activitySchema = {
  type: "object",
  description:
    "Claimed matches only (rows written when the alert notified). Below-threshold scores are not stored. Omitted on create, update, and single-get.",
  required: ["matches7d", "matches30d", "lastMatchedAt", "lastMatch"],
  properties: {
    matches7d: { type: "integer", minimum: 0 },
    matches30d: { type: "integer", minimum: 0 },
    lastMatchedAt: { type: "string", format: "date-time", nullable: true },
    lastMatch: {
      type: "object",
      nullable: true,
      required: ["releaseId", "title", "path"],
      properties: {
        releaseId: { type: "string" },
        title: { type: "string" },
        path: { type: "string", description: "Canonical site path, `/release/rel_…`." },
      },
    },
  },
} as const;

const listAlertSchema = {
  type: "object",
  required: [...alertSchema.required, "activity"],
  properties: {
    ...alertSchema.properties,
    activity: activitySchema,
  },
} as const;

function jsonBody(description: string, schema: Record<string, unknown>) {
  return {
    description,
    content: { "application/json": { schema } },
  };
}

async function semanticAlertsOn(c: Context<Env>): Promise<boolean> {
  return flag(c.env.FLAGS, c.env.SEMANTIC_ALERTS_ENABLED, FLAGS.semanticAlertsEnabled);
}

/** Session first (401), then the flag (404). Matches production middleware order. */
async function gate(c: Context<Env>): Promise<Response | { userId: string }> {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  if (!(await semanticAlertsOn(c))) return respondError(c, new NotFoundError("Not found"));
  return { userId: session.user.id };
}

function privateJson(c: Context<Env>, body: unknown, status: 200 | 201 = 200) {
  c.header("Cache-Control", "private, no-store");
  return c.json(body, status);
}

async function readJson(c: Context<Env>): Promise<Record<string, unknown> | Response> {
  try {
    const body = await c.req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return respondError(c, new ValidationError("Invalid JSON body", { code: "invalid_json" }));
    }
    return body as Record<string, unknown>;
  } catch {
    return respondError(c, new ValidationError("Invalid JSON body", { code: "invalid_json" }));
  }
}

function parseQueryField(c: Context<Env>, value: unknown): string | Response {
  if (typeof value !== "string" || value.trim().length === 0) {
    return respondError(c, new ValidationError("query is required", { code: "bad_request" }));
  }
  const query = value.trim();
  if (query.length > SEMANTIC_ALERT_QUERY_MAX_CHARS) {
    return respondError(
      c,
      new ValidationError(`query must be at most ${SEMANTIC_ALERT_QUERY_MAX_CHARS} characters`, {
        code: "bad_request",
      }),
    );
  }
  return query;
}

function parseThreshold(c: Context<Env>, value: unknown): number | Response {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return respondError(
      c,
      new ValidationError(
        `threshold must be a number from ${SEMANTIC_ALERT_THRESHOLD_MIN.toFixed(2)} to ${SEMANTIC_ALERT_THRESHOLD_MAX.toFixed(2)}`,
        { code: "bad_request" },
      ),
    );
  }
  const rounded = Math.round(value * 100) / 100;
  if (rounded < SEMANTIC_ALERT_THRESHOLD_MIN || rounded > SEMANTIC_ALERT_THRESHOLD_MAX) {
    return respondError(
      c,
      new ValidationError(
        `threshold must be a number from ${SEMANTIC_ALERT_THRESHOLD_MIN.toFixed(2)} to ${SEMANTIC_ALERT_THRESHOLD_MAX.toFixed(2)}`,
        { code: "bad_request" },
      ),
    );
  }
  return rounded;
}

function parseBoolean(c: Context<Env>, value: unknown, field: string): boolean | Response {
  if (typeof value !== "boolean") {
    return respondError(
      c,
      new ValidationError(`${field} must be a boolean`, { code: "bad_request" }),
    );
  }
  return value;
}

async function parseWebhookId(
  c: Context<Env>,
  userId: string,
  value: unknown,
): Promise<string | null | Response> {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    return respondError(
      c,
      new ValidationError("webhookSubscriptionId must be a string or null", {
        code: "bad_request",
      }),
    );
  }
  const db = createDb(c.env.DB);
  const owned = await userOwnsWebhookSubscription(db, userId, value);
  if (!owned) {
    return respondError(
      c,
      new ValidationError("webhookSubscriptionId must be one of your webhook subscriptions", {
        code: "bad_request",
      }),
    );
  }
  return value;
}

meSemanticAlertHandlers.get(
  "/me/semantic-alerts",
  describeRoute({
    tags: ["Account"],
    summary: "List your semantic alerts",
    description: LANE_DESCRIPTION,
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonBody(
        "The caller's alerts, each with recent claimed-match activity. Empty when none are saved.",
        {
          type: "object",
          required: ["alerts", "candidatePool", "maxAlerts"],
          properties: {
            alerts: { type: "array", items: listAlertSchema },
            candidatePool: { type: "string", enum: ["follows"] },
            maxAlerts: { type: "integer" },
          },
        },
      ),
      401: errorResponse("Sign-in required"),
      404: errorResponse("Semantic alerts are disabled"),
    },
  }),
  async (c) => {
    const gated = await gate(c);
    if (gated instanceof Response) return gated;
    const db = createDb(c.env.DB);
    const body: SemanticAlertListResponse = {
      alerts: await listSemanticAlerts(db, gated.userId),
      candidatePool: SEMANTIC_ALERT_CANDIDATE_POOL,
      maxAlerts: SEMANTIC_ALERT_MAX_PER_USER,
    };
    return privateJson(c, body);
  },
);

meSemanticAlertHandlers.get(
  "/me/semantic-alerts/:id",
  describeRoute({
    tags: ["Account"],
    summary: "Get one of your semantic alerts",
    description: LANE_DESCRIPTION,
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonBody("The alert.", alertSchema),
      401: errorResponse("Sign-in required"),
      404: errorResponse("Alert not found, or semantic alerts are disabled"),
    },
  }),
  async (c) => {
    const gated = await gate(c);
    if (gated instanceof Response) return gated;
    const db = createDb(c.env.DB);
    const row = await getSemanticAlert(db, gated.userId, c.req.param("id"));
    if (!row) return respondError(c, new NotFoundError("Semantic alert not found"));
    return privateJson(c, toSemanticAlert(row));
  },
);

meSemanticAlertHandlers.post(
  "/me/semantic-alerts",
  describeRoute({
    tags: ["Account"],
    summary: "Create a semantic alert",
    description: `${LANE_DESCRIPTION} Body: \`{ query, enabled?, threshold?, deliverEmail?, deliverWebhook?, webhookSubscriptionId? }\`. \`query\` is required, trimmed, and at most ${SEMANTIC_ALERT_QUERY_MAX_CHARS} characters. Omitted \`enabled\` defaults to true, \`threshold\` to ${SEMANTIC_ALERT_THRESHOLD_DEFAULT}, \`deliverEmail\` to true, \`deliverWebhook\` to false.`,
    security: [{ bearerAuth: [] }],
    responses: {
      201: jsonBody("The created alert.", alertSchema),
      400: errorResponse("Invalid query, threshold, booleans, or webhookSubscriptionId"),
      401: errorResponse("Sign-in required"),
      404: errorResponse("Semantic alerts are disabled"),
      429: errorResponse("Maximum semantic alerts per account reached"),
    },
  }),
  async (c) => {
    const gated = await gate(c);
    if (gated instanceof Response) return gated;
    const body = await readJson(c);
    if (body instanceof Response) return body;

    const query = parseQueryField(c, body.query);
    if (query instanceof Response) return query;

    const enabled = body.enabled === undefined ? true : parseBoolean(c, body.enabled, "enabled");
    if (enabled instanceof Response) return enabled;

    const threshold =
      body.threshold === undefined
        ? SEMANTIC_ALERT_THRESHOLD_DEFAULT
        : parseThreshold(c, body.threshold);
    if (threshold instanceof Response) return threshold;

    const deliverEmail =
      body.deliverEmail === undefined ? true : parseBoolean(c, body.deliverEmail, "deliverEmail");
    if (deliverEmail instanceof Response) return deliverEmail;

    const deliverWebhook =
      body.deliverWebhook === undefined
        ? false
        : parseBoolean(c, body.deliverWebhook, "deliverWebhook");
    if (deliverWebhook instanceof Response) return deliverWebhook;

    let webhookSubscriptionId: string | null = null;
    if (body.webhookSubscriptionId !== undefined) {
      const parsed = await parseWebhookId(c, gated.userId, body.webhookSubscriptionId);
      if (parsed instanceof Response) return parsed;
      webhookSubscriptionId = parsed;
    }

    const db = createDb(c.env.DB);
    const existing = await countSemanticAlerts(db, gated.userId);
    if (existing >= SEMANTIC_ALERT_MAX_PER_USER) {
      return respondError(
        c,
        new RateLimitedError(`Maximum ${SEMANTIC_ALERT_MAX_PER_USER} semantic alerts per account`, {
          code: "limit_exceeded",
        }),
      );
    }

    const input: NewSemanticAlertInput = {
      query,
      enabled,
      threshold,
      deliverEmail,
      deliverWebhook,
      webhookSubscriptionId,
    };
    const created = await insertSemanticAlert(db, gated.userId, input);
    return privateJson(c, created, 201);
  },
);

meSemanticAlertHandlers.patch(
  "/me/semantic-alerts/:id",
  describeRoute({
    tags: ["Account"],
    summary: "Update a semantic alert",
    description: `${LANE_DESCRIPTION} Partial body. \`webhookSubscriptionId: null\` clears the link. An empty body returns the current alert.`,
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonBody("The updated alert.", alertSchema),
      400: errorResponse("Invalid query, threshold, booleans, or webhookSubscriptionId"),
      401: errorResponse("Sign-in required"),
      404: errorResponse("Alert not found, or semantic alerts are disabled"),
    },
  }),
  async (c) => {
    const gated = await gate(c);
    if (gated instanceof Response) return gated;
    const body = await readJson(c);
    if (body instanceof Response) return body;

    const db = createDb(c.env.DB);
    const existing = await getSemanticAlert(db, gated.userId, c.req.param("id"));
    if (!existing) return respondError(c, new NotFoundError("Semantic alert not found"));

    const patch: SemanticAlertPatch = {};
    if (body.query !== undefined) {
      const query = parseQueryField(c, body.query);
      if (query instanceof Response) return query;
      patch.query = query;
    }
    if (body.enabled !== undefined) {
      const enabled = parseBoolean(c, body.enabled, "enabled");
      if (enabled instanceof Response) return enabled;
      patch.enabled = enabled;
    }
    if (body.threshold !== undefined) {
      const threshold = parseThreshold(c, body.threshold);
      if (threshold instanceof Response) return threshold;
      patch.threshold = threshold;
    }
    if (body.deliverEmail !== undefined) {
      const deliverEmail = parseBoolean(c, body.deliverEmail, "deliverEmail");
      if (deliverEmail instanceof Response) return deliverEmail;
      patch.deliverEmail = deliverEmail;
    }
    if (body.deliverWebhook !== undefined) {
      const deliverWebhook = parseBoolean(c, body.deliverWebhook, "deliverWebhook");
      if (deliverWebhook instanceof Response) return deliverWebhook;
      patch.deliverWebhook = deliverWebhook;
    }
    if (body.webhookSubscriptionId !== undefined) {
      const webhookSubscriptionId = await parseWebhookId(
        c,
        gated.userId,
        body.webhookSubscriptionId,
      );
      if (webhookSubscriptionId instanceof Response) return webhookSubscriptionId;
      patch.webhookSubscriptionId = webhookSubscriptionId;
    }

    if (Object.keys(patch).length === 0) return privateJson(c, toSemanticAlert(existing));

    const updated = await updateSemanticAlert(db, gated.userId, existing.id, patch);
    if (!updated) return respondError(c, new NotFoundError("Semantic alert not found"));
    return privateJson(c, updated);
  },
);

meSemanticAlertHandlers.delete(
  "/me/semantic-alerts/:id",
  describeRoute({
    tags: ["Account"],
    summary: "Delete a semantic alert",
    description: LANE_DESCRIPTION,
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: "Deleted." },
      401: errorResponse("Sign-in required"),
      404: errorResponse("Alert not found, or semantic alerts are disabled"),
    },
  }),
  async (c) => {
    const gated = await gate(c);
    if (gated instanceof Response) return gated;
    const db = createDb(c.env.DB);
    const deleted = await deleteSemanticAlert(db, gated.userId, c.req.param("id"));
    if (!deleted) return respondError(c, new NotFoundError("Semantic alert not found"));
    c.header("Cache-Control", "private, no-store");
    return new Response(null, { status: 204 });
  },
);
