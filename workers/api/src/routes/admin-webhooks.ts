/**
 * Admin-only routes for managing webhook subscriptions. Gated by authMiddleware
 * via the `admin/webhooks` entry in workers/api/src/index.ts.
 */
import { Hono } from "hono";
import { deriveSigningKey } from "@buildinternet/releases-core/webhook-sign";
import { createDb } from "../db.js";
import {
  insertWebhookSubscription,
  getWebhookSubscriptionById,
  listWebhookSubscriptionsByOrg,
} from "../webhooks/queries.js";
import type { Env } from "../index.js";

export const adminWebhooksRoutes = new Hono<Env>();

function getDb(c: any): any {
  return c.get("db") ?? createDb(c.env.DB);
}

// POST /v1/admin/webhooks — create a new webhook subscription.
// Returns 201 with { ...sub, signingKey }. The signing key is shown once.
adminWebhooksRoutes.post("/v1/admin/webhooks", async (c) => {
  const masterKey: string | undefined = await c.env.WEBHOOK_HMAC_MASTER?.get();
  if (!masterKey) {
    return c.json({ error: "service_unavailable", message: "WEBHOOK_HMAC_MASTER not configured" }, 503);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_request", message: "invalid JSON body" }, 400);
  }

  const { orgId, url, sourceId, description } = body as Record<string, unknown>;

  if (!orgId || typeof orgId !== "string") {
    return c.json({ error: "bad_request", message: "orgId is required" }, 400);
  }
  if (!url || typeof url !== "string") {
    return c.json({ error: "bad_request", message: "url is required" }, 400);
  }
  if (!url.startsWith("https://")) {
    return c.json({ error: "bad_request", message: "url must use HTTPS" }, 400);
  }

  const db = getDb(c);
  const sub = await insertWebhookSubscription(db, {
    orgId,
    url,
    sourceId: typeof sourceId === "string" ? sourceId : null,
    description: typeof description === "string" ? description : null,
  });

  const signingKey = await deriveSigningKey(masterKey, sub.id, sub.secretVersion);

  return c.json({ ...sub, signingKey }, 201);
});

// GET /v1/admin/webhooks — list subscriptions for an org.
// Requires ?org=<orgId>. Optional ?enabled=true|false filter.
adminWebhooksRoutes.get("/v1/admin/webhooks", async (c) => {
  const orgId = c.req.query("org");
  if (!orgId) {
    return c.json({ error: "bad_request", message: "org query param is required" }, 400);
  }

  const enabledParam = c.req.query("enabled");
  const opts = enabledParam !== undefined
    ? { enabledOnly: enabledParam === "true" }
    : undefined;

  const db = getDb(c);
  const subscriptions = await listWebhookSubscriptionsByOrg(db, orgId, opts);
  return c.json({ subscriptions });
});

// GET /v1/admin/webhooks/:id — show a single subscription.
adminWebhooksRoutes.get("/v1/admin/webhooks/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  const sub = await getWebhookSubscriptionById(db, id);
  if (!sub) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json(sub);
});
