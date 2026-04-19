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
  updateWebhookSubscription,
  deleteWebhookSubscription,
  bumpWebhookSecretVersion,
} from "../webhooks/queries.js";
import type { Env } from "../index.js";

/** Subscription ID safe-pattern for AE SQL: whk_ followed by alphanumeric/underscore. */
const SUBSCRIPTION_ID_RE = /^whk_[a-zA-Z0-9_]+$/;

/** Validate that a URL string is parseable and uses HTTPS. Returns an error message or null. */
function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url is invalid";
  }
  if (parsed.protocol !== "https:") {
    return "url must use HTTPS";
  }
  return null;
}

export const adminWebhooksRoutes = new Hono<Env>();

function getDb(c: any): any {
  return c.get("db") ?? createDb(c.env.DB);
}

adminWebhooksRoutes.post("/v1/admin/webhooks", async (c) => {
  const masterKey: string | undefined = await c.env.WEBHOOK_HMAC_MASTER?.get();
  if (!masterKey) {
    return c.json({ error: "webhook_unavailable", message: "WEBHOOK_HMAC_MASTER not configured" }, 503);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_request", message: "invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null) {
    return c.json({ error: "bad_request", message: "body must be an object" }, 400);
  }

  const { orgId, url, sourceId, description } = body as Record<string, unknown>;

  if (!orgId || typeof orgId !== "string") {
    return c.json({ error: "bad_request", message: "orgId is required" }, 400);
  }
  if (!url || typeof url !== "string") {
    return c.json({ error: "bad_request", message: "url is required" }, 400);
  }
  const urlError = validateUrl(url);
  if (urlError) {
    return c.json({ error: "bad_request", message: urlError }, 400);
  }

  const db = getDb(c);
  const sub = await insertWebhookSubscription(db, {
    orgId,
    url,
    sourceId: typeof sourceId === "string" ? sourceId : null,
    description: typeof description === "string" ? description : null,
  });

  // Signing key is derived deterministically from master + sub.id + secretVersion.
  // Returned here ONLY — re-derivation requires `rotate-secret`.
  const signingKey = await deriveSigningKey(masterKey, sub.id, sub.secretVersion);

  return c.json({ ...sub, signingKey }, 201);
});

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

adminWebhooksRoutes.get("/v1/admin/webhooks/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  const sub = await getWebhookSubscriptionById(db, id);
  if (!sub) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json(sub);
});

adminWebhooksRoutes.patch("/v1/admin/webhooks/:id", async (c) => {
  let body: Partial<{
    url: string;
    description: string | null;
    enabled: boolean;
    disabledReason: string | null;
  }>;
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "bad_request", message: "invalid JSON body" }, 400);
  }

  if (body.url !== undefined) {
    const urlError = validateUrl(body.url);
    if (urlError) {
      return c.json({ error: "bad_request", message: urlError }, 400);
    }
  }

  const updates: Parameters<typeof updateWebhookSubscription>[2] = {};
  if (body.url !== undefined) updates.url = body.url;
  if (body.description !== undefined) updates.description = body.description;
  if (body.enabled !== undefined) {
    updates.enabled = body.enabled;
    if (body.enabled) {
      updates.consecutiveFailures = 0;
      updates.disabledReason = null;
    } else {
      updates.disabledReason = body.disabledReason ?? "manually disabled";
    }
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "bad_request", message: "no recognized fields to update" }, 400);
  }

  const id = c.req.param("id");
  const fresh = await updateWebhookSubscription(getDb(c), id, updates);
  if (!fresh) return c.json({ error: "not_found" }, 404);
  return c.json(fresh);
});

adminWebhooksRoutes.delete("/v1/admin/webhooks/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  await deleteWebhookSubscription(db, id);
  return new Response(null, { status: 204 });
});

adminWebhooksRoutes.post("/v1/admin/webhooks/:id/rotate-secret", async (c) => {
  const masterKey: string | undefined = await c.env.WEBHOOK_HMAC_MASTER?.get();
  if (!masterKey) {
    return c.json({ error: "webhook_unavailable", message: "WEBHOOK_HMAC_MASTER not configured" }, 503);
  }

  const id = c.req.param("id");
  const db = getDb(c);

  // Verify existence before bumping — bumpWebhookSecretVersion throws if missing,
  // but we want a clean 404 JSON response.
  const existing = await getWebhookSubscriptionById(db, id);
  if (!existing) {
    return c.json({ error: "not_found" }, 404);
  }

  const newVersion = await bumpWebhookSecretVersion(db, id);
  const signingKey = await deriveSigningKey(masterKey, id, newVersion);
  return c.json({ secretVersion: newVersion, signingKey });
});

adminWebhooksRoutes.post("/v1/admin/webhooks/:id/test", async (c) => {
  const queue = c.env.WEBHOOK_DELIVERY_QUEUE;
  if (!queue) {
    return c.json({ error: "queue_unavailable", message: "WEBHOOK_DELIVERY_QUEUE binding missing" }, 503);
  }

  const id = c.req.param("id");
  const db = getDb(c);
  const sub = await getWebhookSubscriptionById(db, id);
  if (!sub) {
    return c.json({ error: "not_found" }, 404);
  }

  const synthetic = {
    subscriptionId: sub.id,
    url: sub.url,
    secretVersion: sub.secretVersion,
    event: {
      id: `test_${Date.now()}`,
      seq: 0,
      ts: Date.now(),
      type: "release.created" as const,
      release: {
        id: "rel_synthetic",
        title: "Webhook test",
        version: null,
        publishedAt: null,
        sourceName: "synthetic",
        sourceSlug: "synthetic",
        contentSummary: "This is a synthetic test event from `releases admin webhook test`.",
        media: [],
      },
    },
    attempt: 1,
  };

  await queue.send(synthetic);
  return c.json({ enqueued: true, eventId: synthetic.event.id });
});

adminWebhooksRoutes.get("/v1/admin/webhooks/:id/deliveries", async (c) => {
  const cfApiToken: string | undefined = await c.env.CF_API_TOKEN?.get();
  const cfAccountId: string | undefined = c.env.CF_ACCOUNT_ID;

  if (!cfApiToken || !cfAccountId) {
    return c.json(
      { error: "deliveries_unavailable", message: "set CF_API_TOKEN + CF_ACCOUNT_ID to enable" },
      501,
    );
  }

  const id = c.req.param("id");
  // Validate id against safe pattern before using in SQL.
  // AE SQL API does not support bound parameters — we build the query string,
  // so we must ensure id contains only safe characters.
  if (!SUBSCRIPTION_ID_RE.test(id)) {
    return c.json({ error: "bad_request", message: "invalid subscription id format" }, 400);
  }

  const failedOnly = c.req.query("failed") === "true";
  const limitParam = parseInt(c.req.query("limit") ?? "20", 10);
  const limit = isNaN(limitParam) || limitParam < 1 ? 20 : Math.min(100, limitParam);

  // Build SQL with validated, safe values only (id is regex-checked, limit is an integer).
  const failedFilter = failedOnly
    ? ` AND blob4 IN ('retry','perm_fail','dlq','auto_disabled')`
    : "";
  const sql =
    `SELECT timestamp, blob1 AS event_id, blob2 AS error_message, blob3 AS error_code, ` +
    `blob4 AS outcome, double1 AS http_status, double2 AS latency_ms, double3 AS attempt ` +
    `FROM webhook_deliveries ` +
    `WHERE index1 = '${id}'${failedFilter} ` +
    `ORDER BY timestamp DESC LIMIT ${limit}`;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${cfApiToken}` },
      body: sql,
    },
  );

  if (!res.ok) {
    return c.json({ error: "ae_query_failed", message: `AE query returned ${res.status}` }, 502);
  }

  const data = await res.json();
  return c.json(data);
});
