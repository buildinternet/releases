/**
 * Self-serve webhook subscription routes at `/v1/me/webhooks/*`.
 * User-owned rows carry `user_id`; the delivery pipeline is unchanged.
 */
import { Hono } from "hono";
import { createDb } from "../db.js";
import {
  insertWebhookSubscription,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  bumpWebhookSecretVersion,
} from "../webhooks/queries.js";
import {
  buildWebhookPatchUpdates,
  fetchWebhookDeliveries,
  requireMasterKey,
  signingKeyFor,
  SUBSCRIPTION_ID_RE,
  validateWebhookUrl,
} from "../webhooks/shared.js";
import type { WebhookSubscription } from "@buildinternet/releases-core/schema";
import {
  countUserWebhookSubscriptions,
  getUserWebhookSubscription,
  listUserWebhookSubscriptionsEnriched,
  MAX_USER_WEBHOOK_SUBSCRIPTIONS,
  resolveWebhookOrg,
  resolveWebhookSource,
  userWebhookDeliveryHealth,
} from "../webhooks/user-queries.js";
import { newEventId } from "../events/types.js";
import type { DeliveryMessage } from "../webhooks/types.js";
import { getSecret } from "@releases/lib/secrets";
import type { Env } from "../index.js";

export const meWebhookHandlers = new Hono<Env>();

function getDb(c: { env: Env["Bindings"]; get: (k: "db") => unknown }) {
  return (c.get("db") as ReturnType<typeof createDb> | undefined) ?? createDb(c.env.DB);
}

function jsonSubscription(sub: WebhookSubscription) {
  return { ...sub, ...userWebhookDeliveryHealth(sub) };
}

meWebhookHandlers.get("/me/webhooks", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);

  const enabledParam = c.req.query("enabled");
  const opts = enabledParam !== undefined ? { enabledOnly: enabledParam === "true" } : undefined;

  const db = getDb(c);
  const subscriptions = await listUserWebhookSubscriptionsEnriched(db, session.user.id, opts);
  return c.json({ subscriptions });
});

meWebhookHandlers.post("/me/webhooks", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);

  const masterKey = await requireMasterKey(c);
  if (masterKey instanceof Response) return masterKey;

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "bad_request", message: "invalid JSON body" }, 400);
  }

  const url = body.url;
  if (typeof url !== "string" || !url) {
    return c.json({ error: "bad_request", message: "url is required" }, 400);
  }
  const urlError = validateWebhookUrl(url);
  if (urlError) return c.json({ error: "bad_request", message: urlError }, 400);

  const orgId = typeof body.orgId === "string" ? body.orgId : undefined;
  const orgSlug = typeof body.orgSlug === "string" ? body.orgSlug : undefined;
  if (!orgId && !orgSlug) {
    return c.json({ error: "bad_request", message: "orgId or orgSlug is required" }, 400);
  }

  const db = getDb(c);
  const org = await resolveWebhookOrg(db, { orgId, orgSlug });
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const sourceId = typeof body.sourceId === "string" ? body.sourceId : undefined;
  const sourceSlug = typeof body.sourceSlug === "string" ? body.sourceSlug : undefined;
  let resolvedSourceId: string | null = null;
  if (sourceId || sourceSlug) {
    const source = await resolveWebhookSource(db, org.id, { sourceId, sourceSlug });
    if (!source) {
      return c.json({ error: "not_found", message: "Source not found for this organization" }, 404);
    }
    resolvedSourceId = source.id;
  }

  const count = await countUserWebhookSubscriptions(db, session.user.id);
  if (count >= MAX_USER_WEBHOOK_SUBSCRIPTIONS) {
    return c.json(
      {
        error: "limit_exceeded",
        message: `Maximum ${MAX_USER_WEBHOOK_SUBSCRIPTIONS} webhook subscriptions per account`,
      },
      429,
    );
  }

  const description = typeof body.description === "string" ? body.description : null;
  const sub = await insertWebhookSubscription(db, {
    orgId: org.id,
    url,
    sourceId: resolvedSourceId,
    description,
    userId: session.user.id,
  });

  const signingKey = await signingKeyFor(masterKey, sub.id, sub.secretVersion);
  return c.json(
    { ...jsonSubscription(sub), orgSlug: org.slug, orgName: org.name, signingKey },
    201,
  );
});

meWebhookHandlers.get("/me/webhooks/:id", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);

  const id = c.req.param("id");
  const db = getDb(c);
  const sub = await getUserWebhookSubscription(db, session.user.id, id);
  if (!sub) return c.json({ error: "not_found" }, 404);
  return c.json(jsonSubscription(sub));
});

meWebhookHandlers.patch("/me/webhooks/:id", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);

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

  const patch = buildWebhookPatchUpdates(body);
  if ("error" in patch) {
    return c.json({ error: "bad_request", message: patch.error }, 400);
  }

  const id = c.req.param("id");
  const db = getDb(c);
  const owned = await getUserWebhookSubscription(db, session.user.id, id);
  if (!owned) return c.json({ error: "not_found" }, 404);

  const fresh = await updateWebhookSubscription(db, id, patch);
  if (!fresh) return c.json({ error: "not_found" }, 404);
  return c.json(jsonSubscription(fresh));
});

meWebhookHandlers.delete("/me/webhooks/:id", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);

  const id = c.req.param("id");
  const db = getDb(c);
  const owned = await getUserWebhookSubscription(db, session.user.id, id);
  if (!owned) return c.json({ error: "not_found" }, 404);

  await deleteWebhookSubscription(db, id);
  return new Response(null, { status: 204 });
});

meWebhookHandlers.post("/me/webhooks/:id/rotate-secret", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);

  const masterKey = await requireMasterKey(c);
  if (masterKey instanceof Response) return masterKey;

  const id = c.req.param("id");
  const db = getDb(c);
  const owned = await getUserWebhookSubscription(db, session.user.id, id);
  if (!owned) return c.json({ error: "not_found" }, 404);

  const newVersion = await bumpWebhookSecretVersion(db, id);
  if (newVersion === null) return c.json({ error: "not_found" }, 404);

  const signingKey = await signingKeyFor(masterKey, id, newVersion);
  return c.json({ secretVersion: newVersion, signingKey });
});

meWebhookHandlers.post("/me/webhooks/:id/test", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);

  const queue = c.env.WEBHOOK_DELIVERY_QUEUE;
  if (!queue) {
    return c.json(
      { error: "queue_unavailable", message: "WEBHOOK_DELIVERY_QUEUE binding missing" },
      503,
    );
  }

  const id = c.req.param("id");
  const db = getDb(c);
  const sub = await getUserWebhookSubscription(db, session.user.id, id);
  if (!sub) return c.json({ error: "not_found" }, 404);

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
        summary: "This is a synthetic test event from your Releases webhook subscription.",
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

meWebhookHandlers.get("/me/webhooks/:id/deliveries", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);

  const cfApiToken = (await getSecret(c.env.CF_API_TOKEN)) ?? undefined;
  const cfAccountId: string | undefined = c.env.CF_ACCOUNT_ID;
  if (!cfApiToken || !cfAccountId) {
    return c.json(
      { error: "deliveries_unavailable", message: "set CF_API_TOKEN + CF_ACCOUNT_ID to enable" },
      501,
    );
  }

  const id = c.req.param("id");
  if (!SUBSCRIPTION_ID_RE.test(id)) {
    return c.json({ error: "bad_request", message: "invalid subscription id format" }, 400);
  }

  const db = getDb(c);
  const owned = await getUserWebhookSubscription(db, session.user.id, id);
  if (!owned) return c.json({ error: "not_found" }, 404);

  const limitParam = parseInt(c.req.query("limit") ?? "20", 10);
  const res = await fetchWebhookDeliveries(cfApiToken, cfAccountId, id, {
    failedOnly: c.req.query("failed") === "true",
    limit: isNaN(limitParam) ? 20 : limitParam,
  });

  if (!res.ok) {
    return c.json({ error: "ae_query_failed", message: `AE query returned ${res.status}` }, 502);
  }

  const data = await res.json();
  return c.json(data);
});
