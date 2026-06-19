/**
 * Admin webhook subscription routes: CRUD, rotate-secret, test, deliveries.
 * Mounted at /v1/webhooks/*; gated by authMiddleware via the "webhooks" allowlist entry.
 */
import { Hono } from "hono";
import { createDb } from "../db.js";
import {
  insertWebhookSubscription,
  getWebhookSubscriptionById,
  listWebhookSubscriptionsByOrg,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  bumpWebhookSecretVersion,
} from "../webhooks/queries.js";
import { newEventId } from "../events/types.js";
import type { DeliveryMessage } from "../webhooks/types.js";

import type { Env } from "../index.js";
import {
  buildWebhookPatchUpdates,
  queryWebhookDeliveries,
  requireMasterKey,
  signingKeyFor,
} from "../webhooks/shared.js";
import { assertPublicWebhookTarget } from "../webhooks/url-safety.js";

export const webhooksRoutes = new Hono<Env>();

function getDb(c: any): any {
  return c.get("db") ?? createDb(c.env.DB);
}

webhooksRoutes.post("/webhooks", async (c) => {
  const masterKey = await requireMasterKey(c);
  if (masterKey instanceof Response) return masterKey;

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
  const urlError = await assertPublicWebhookTarget(url);
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

  const signingKey = await signingKeyFor(masterKey, sub.id, sub.secretVersion);

  return c.json({ ...sub, signingKey }, 201);
});

webhooksRoutes.get("/webhooks", async (c) => {
  const orgId = c.req.query("org");
  if (!orgId) {
    return c.json({ error: "bad_request", message: "org query param is required" }, 400);
  }

  const enabledParam = c.req.query("enabled");
  const opts = enabledParam !== undefined ? { enabledOnly: enabledParam === "true" } : undefined;

  const db = getDb(c);
  const subscriptions = await listWebhookSubscriptionsByOrg(db, orgId, opts);
  return c.json({ subscriptions });
});

webhooksRoutes.get("/webhooks/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  const sub = await getWebhookSubscriptionById(db, id);
  if (!sub) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json(sub);
});

webhooksRoutes.patch("/webhooks/:id", async (c) => {
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
    const urlError = await assertPublicWebhookTarget(body.url);
    if (urlError) {
      return c.json({ error: "bad_request", message: urlError }, 400);
    }
  }

  const patch = buildWebhookPatchUpdates(body);
  if ("error" in patch) {
    return c.json({ error: "bad_request", message: patch.error }, 400);
  }

  const id = c.req.param("id");
  const fresh = await updateWebhookSubscription(getDb(c), id, patch);
  if (!fresh) return c.json({ error: "not_found" }, 404);
  return c.json(fresh);
});

webhooksRoutes.delete("/webhooks/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  await deleteWebhookSubscription(db, id);
  return new Response(null, { status: 204 });
});

webhooksRoutes.post("/webhooks/:id/rotate-secret", async (c) => {
  const masterKey = await requireMasterKey(c);
  if (masterKey instanceof Response) return masterKey;

  const id = c.req.param("id");
  const newVersion = await bumpWebhookSecretVersion(getDb(c), id);
  if (newVersion === null) return c.json({ error: "not_found" }, 404);

  const signingKey = await signingKeyFor(masterKey, id, newVersion);
  return c.json({ secretVersion: newVersion, signingKey });
});

webhooksRoutes.post("/webhooks/:id/test", async (c) => {
  const queue = c.env.WEBHOOK_DELIVERY_QUEUE;
  if (!queue) {
    return c.json(
      { error: "queue_unavailable", message: "WEBHOOK_DELIVERY_QUEUE binding missing" },
      503,
    );
  }

  const id = c.req.param("id");
  const db = getDb(c);
  const sub = await getWebhookSubscriptionById(db, id);
  if (!sub) {
    return c.json({ error: "not_found" }, 404);
  }

  const synthetic: DeliveryMessage = {
    subscriptionId: sub.id,
    url: sub.url,
    secretVersion: sub.secretVersion,
    event: {
      id: newEventId(),
      seq: 0,
      ts: Date.now(),
      type: "release.created",
      release: {
        id: "rel_synthetic",
        title: "Webhook test",
        version: null,
        publishedAt: null,
        sourceName: "synthetic",
        sourceSlug: "synthetic",
        summary: "This is a synthetic test event from `releases admin webhook test`.",
        titleGenerated: null,
        titleShort: null,
        media: [],
        contentChars: null,
        contentTokens: null,
      },
    },
    attempt: 1,
  };

  await queue.send(synthetic);
  return c.json({ enqueued: true, eventId: synthetic.event.id });
});

webhooksRoutes.get("/webhooks/:id/deliveries", async (c) => {
  const id = c.req.param("id");
  const result = await queryWebhookDeliveries(c.env, id, {
    failed: c.req.query("failed"),
    limit: c.req.query("limit"),
  });
  return c.json(result.body, result.status as 200 | 400 | 501 | 502);
});
