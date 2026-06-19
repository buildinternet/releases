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
} from "../webhooks/shared.js";
import { assertPublicWebhookTarget } from "../webhooks/url-safety.js";
import {
  checkWebhookTestRateLimit,
  webhookTestRateLimitResponse,
} from "../webhooks/test-rate-limit.js";
import type { WebhookSubscription } from "@buildinternet/releases-core/schema";
import {
  countUserOrgWebhookSubscriptions,
  getUserFollowsWebhookSubscription,
  getUserWebhookSubscription,
  listUserWebhookSubscriptionsEnriched,
  MAX_USER_FOLLOWS_WEBHOOK_SUBSCRIPTIONS,
  MAX_USER_WEBHOOK_SUBSCRIPTIONS,
  resolveWebhookOrg,
  resolveWebhookProduct,
  resolveWebhookSource,
  sourceProductFilterMismatch,
  userWebhookDeliveryHealth,
} from "../webhooks/user-queries.js";
import { parseReleaseTypeFilter } from "../webhooks/subscription-match.js";
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
  const urlError = await assertPublicWebhookTarget(url);
  if (urlError) return c.json({ error: "bad_request", message: urlError }, 400);

  const scope = body.scope === "follows" ? "follows" : "org";
  const db = getDb(c);
  const description = typeof body.description === "string" ? body.description : null;

  if (scope === "follows") {
    const orgId = typeof body.orgId === "string" ? body.orgId : undefined;
    const orgSlug = typeof body.orgSlug === "string" ? body.orgSlug : undefined;
    const sourceId = typeof body.sourceId === "string" ? body.sourceId : undefined;
    const sourceSlug = typeof body.sourceSlug === "string" ? body.sourceSlug : undefined;
    const productId = typeof body.productId === "string" ? body.productId : undefined;
    const productSlug = typeof body.productSlug === "string" ? body.productSlug : undefined;
    if (orgId || orgSlug || sourceId || sourceSlug || productId || productSlug) {
      return c.json(
        {
          error: "bad_request",
          message:
            "follows-scoped webhooks must not include orgId, orgSlug, sourceId, sourceSlug, productId, or productSlug",
        },
        400,
      );
    }

    const releaseTypeFilter = parseReleaseTypeFilter(body.releaseType);
    if (releaseTypeFilter === "invalid") {
      return c.json(
        { error: "bad_request", message: "releaseType must be feature or rollup" },
        400,
      );
    }

    const existing = await getUserFollowsWebhookSubscription(db, session.user.id);
    if (existing) {
      return c.json(
        {
          error: "limit_exceeded",
          message: `Maximum ${MAX_USER_FOLLOWS_WEBHOOK_SUBSCRIPTIONS} follows-scoped webhook per account`,
        },
        429,
      );
    }

    const sub = await insertWebhookSubscription(db, {
      scope: "follows",
      orgId: null,
      url,
      sourceId: null,
      releaseType: releaseTypeFilter,
      description,
      userId: session.user.id,
    });

    const signingKey = await signingKeyFor(masterKey, sub.id, sub.secretVersion);
    return c.json(
      {
        ...jsonSubscription(sub),
        orgSlug: null,
        orgName: null,
        signingKey,
      },
      201,
    );
  }

  const orgId = typeof body.orgId === "string" ? body.orgId : undefined;
  const orgSlug = typeof body.orgSlug === "string" ? body.orgSlug : undefined;
  if (!orgId && !orgSlug) {
    return c.json({ error: "bad_request", message: "orgId or orgSlug is required" }, 400);
  }

  const org = await resolveWebhookOrg(db, { orgId, orgSlug });
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const sourceId = typeof body.sourceId === "string" ? body.sourceId : undefined;
  const sourceSlug = typeof body.sourceSlug === "string" ? body.sourceSlug : undefined;
  const productId = typeof body.productId === "string" ? body.productId : undefined;
  const productSlug = typeof body.productSlug === "string" ? body.productSlug : undefined;
  const releaseTypeFilter = parseReleaseTypeFilter(body.releaseType);
  if (releaseTypeFilter === "invalid") {
    return c.json({ error: "bad_request", message: "releaseType must be feature or rollup" }, 400);
  }

  let resolvedSourceId: string | null = null;
  let resolvedSourceProductId: string | null = null;
  if (sourceId || sourceSlug) {
    const source = await resolveWebhookSource(db, org.id, { sourceId, sourceSlug });
    if (!source) {
      return c.json({ error: "not_found", message: "Source not found for this organization" }, 404);
    }
    resolvedSourceId = source.id;
    resolvedSourceProductId = source.productId;
  }

  let resolvedProductId: string | null = null;
  if (productId || productSlug) {
    const product = await resolveWebhookProduct(db, org.id, { productId, productSlug });
    if (!product) {
      return c.json(
        { error: "not_found", message: "Product not found for this organization" },
        404,
      );
    }
    resolvedProductId = product.id;
  }

  if (sourceProductFilterMismatch(resolvedSourceProductId, resolvedProductId)) {
    return c.json(
      {
        error: "bad_request",
        message: "source does not belong to the specified product filter",
      },
      400,
    );
  }

  const count = await countUserOrgWebhookSubscriptions(db, session.user.id);
  if (count >= MAX_USER_WEBHOOK_SUBSCRIPTIONS) {
    return c.json(
      {
        error: "limit_exceeded",
        message: `Maximum ${MAX_USER_WEBHOOK_SUBSCRIPTIONS} org-scoped webhook subscriptions per account`,
      },
      429,
    );
  }

  const sub = await insertWebhookSubscription(db, {
    scope: "org",
    orgId: org.id,
    url,
    sourceId: resolvedSourceId,
    productId: resolvedProductId,
    releaseType: releaseTypeFilter,
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

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "bad_request", message: "invalid JSON body" }, 400);
  }

  if (typeof body.url === "string") {
    const urlError = await assertPublicWebhookTarget(body.url);
    if (urlError) return c.json({ error: "bad_request", message: urlError }, 400);
  }

  const basePatch = buildWebhookPatchUpdates(
    body as Partial<{
      url: string;
      description: string | null;
      enabled: boolean;
      disabledReason: string | null;
    }>,
  );
  const patch =
    "error" in basePatch
      ? ({} as import("../webhooks/queries.js").WebhookSubscriptionUpdates)
      : basePatch;
  if ("error" in basePatch && basePatch.error !== "no recognized fields to update") {
    return c.json({ error: "bad_request", message: basePatch.error }, 400);
  }

  const id = c.req.param("id");
  const db = getDb(c);
  const owned = await getUserWebhookSubscription(db, session.user.id, id);
  if (!owned) return c.json({ error: "not_found" }, 404);

  if (body.releaseType !== undefined) {
    const releaseTypeFilter = parseReleaseTypeFilter(body.releaseType);
    if (releaseTypeFilter === "invalid") {
      return c.json(
        { error: "bad_request", message: "releaseType must be feature or rollup" },
        400,
      );
    }
    patch.releaseType = releaseTypeFilter;
  }

  if (owned.scope === "org") {
    let nextSourceId = owned.sourceId;
    let nextSourceProductId: string | null = null;
    if (body.sourceId !== undefined || body.sourceSlug !== undefined) {
      if (body.sourceId === null && body.sourceSlug === undefined) {
        nextSourceId = null;
      } else {
        const sourceId = typeof body.sourceId === "string" ? body.sourceId : undefined;
        const sourceSlug = typeof body.sourceSlug === "string" ? body.sourceSlug : undefined;
        if (!owned.orgId)
          return c.json({ error: "bad_request", message: "invalid subscription" }, 400);
        const source = await resolveWebhookSource(db, owned.orgId, { sourceId, sourceSlug });
        if (!source) {
          return c.json(
            { error: "not_found", message: "Source not found for this organization" },
            404,
          );
        }
        nextSourceId = source.id;
        nextSourceProductId = source.productId;
      }
    } else if (nextSourceId && owned.orgId) {
      const source = await resolveWebhookSource(db, owned.orgId, { sourceId: nextSourceId });
      nextSourceProductId = source?.productId ?? null;
    }

    let nextProductId = owned.productId;
    if (body.productId !== undefined || body.productSlug !== undefined) {
      if (body.productId === null && body.productSlug === undefined) {
        nextProductId = null;
      } else if (!owned.orgId) {
        return c.json({ error: "bad_request", message: "invalid subscription" }, 400);
      } else {
        const productId = typeof body.productId === "string" ? body.productId : undefined;
        const productSlug = typeof body.productSlug === "string" ? body.productSlug : undefined;
        const product = await resolveWebhookProduct(db, owned.orgId, { productId, productSlug });
        if (!product) {
          return c.json(
            { error: "not_found", message: "Product not found for this organization" },
            404,
          );
        }
        nextProductId = product.id;
      }
    }

    if (sourceProductFilterMismatch(nextSourceProductId, nextProductId)) {
      return c.json(
        {
          error: "bad_request",
          message: "source does not belong to the specified product filter",
        },
        400,
      );
    }

    if (body.sourceId !== undefined || body.sourceSlug !== undefined) patch.sourceId = nextSourceId;
    if (body.productId !== undefined || body.productSlug !== undefined)
      patch.productId = nextProductId;
  } else if (
    body.sourceId !== undefined ||
    body.sourceSlug !== undefined ||
    body.productId !== undefined ||
    body.productSlug !== undefined
  ) {
    return c.json(
      {
        error: "bad_request",
        message:
          "follows-scoped webhooks cannot set sourceId, sourceSlug, productId, or productSlug",
      },
      400,
    );
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "bad_request", message: "no recognized fields to update" }, 400);
  }

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

  const testLimitersEnabled = c.env.WEBHOOK_TEST_RATE_LIMIT_ENABLED !== "false";
  const rateResult = await checkWebhookTestRateLimit(
    {
      sub: testLimitersEnabled ? c.env.WEBHOOK_TEST_SUB_RATE_LIMITER : undefined,
      user: testLimitersEnabled ? c.env.WEBHOOK_TEST_USER_RATE_LIMITER : undefined,
    },
    session.user.id,
    id,
  );
  if (rateResult !== "ok") {
    const limited = webhookTestRateLimitResponse(rateResult);
    c.header("Retry-After", String(limited.retryAfter));
    return c.json(limited.body, limited.status);
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
