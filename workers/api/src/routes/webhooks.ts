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
import { respondError } from "../lib/error-response.js";
import {
  ValidationError,
  NotFoundError,
  ServiceUnavailableError,
  isReleasesError,
} from "@releases/lib/releases-error";

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
    return respondError(c, new ValidationError("invalid JSON body", { code: "invalid_json" }));
  }
  if (typeof body !== "object" || body === null) {
    return respondError(c, new ValidationError("body must be an object", { code: "bad_request" }));
  }

  const { orgId, url, sourceId, description } = body as Record<string, unknown>;

  if (!orgId || typeof orgId !== "string") {
    return respondError(c, new ValidationError("orgId is required", { code: "bad_request" }));
  }
  if (!url || typeof url !== "string") {
    return respondError(c, new ValidationError("url is required", { code: "bad_request" }));
  }
  const urlError = await assertPublicWebhookTarget(url);
  if (urlError) {
    return respondError(c, new ValidationError(urlError, { code: "bad_request" }));
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
    return respondError(
      c,
      new ValidationError("org query param is required", { code: "bad_request" }),
    );
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
    return respondError(c, new NotFoundError());
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
    return respondError(c, new ValidationError("invalid JSON body", { code: "invalid_json" }));
  }

  if (body.url !== undefined) {
    const urlError = await assertPublicWebhookTarget(body.url);
    if (urlError) {
      return respondError(c, new ValidationError(urlError, { code: "bad_request" }));
    }
  }

  const patch = buildWebhookPatchUpdates(body);
  if ("error" in patch) {
    return respondError(c, new ValidationError(patch.error, { code: "bad_request" }));
  }

  const id = c.req.param("id");
  const fresh = await updateWebhookSubscription(getDb(c), id, patch);
  if (!fresh) return respondError(c, new NotFoundError());
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
  if (newVersion === null) return respondError(c, new NotFoundError());

  const signingKey = await signingKeyFor(masterKey, id, newVersion);
  return c.json({ secretVersion: newVersion, signingKey });
});

webhooksRoutes.post("/webhooks/:id/test", async (c) => {
  const queue = c.env.WEBHOOK_DELIVERY_QUEUE;
  if (!queue) {
    return respondError(
      c,
      new ServiceUnavailableError("WEBHOOK_DELIVERY_QUEUE binding missing", {
        code: "service_unavailable",
        details: { resource: "queue" },
      }),
    );
  }

  const id = c.req.param("id");
  const db = getDb(c);
  const sub = await getWebhookSubscriptionById(db, id);
  if (!sub) {
    return respondError(c, new NotFoundError());
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
  if (isReleasesError(result)) return respondError(c, result);
  return c.json(result.data);
});
