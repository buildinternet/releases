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
  queryWebhookDeliveries,
  requireMasterKey,
  signingKeyFor,
} from "../webhooks/shared.js";
import { assertPublicWebhookTarget, validateSlackWebhookUrl } from "../webhooks/url-safety.js";
import {
  checkWebhookTestRateLimit,
  WEBHOOK_TEST_RATE_WINDOW_SECONDS,
  webhookTestRateLimitMessage,
} from "../webhooks/test-rate-limit.js";
import type { WebhookSubscription, WebhookFormat } from "@buildinternet/releases-core/schema";
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

import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { userIdempotencyPrincipal } from "../lib/idempotency-principal.js";
import { idempotentPost } from "../middleware/idempotency.js";
import {
  UnauthorizedError,
  ValidationError,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
  isReleasesError,
} from "@releases/lib/releases-error";

export const meWebhookHandlers = new Hono<Env>();

function getDb(c: { env: Env["Bindings"]; get: (k: "db") => unknown }) {
  return (c.get("db") as ReturnType<typeof createDb> | undefined) ?? createDb(c.env.DB);
}

function jsonSubscription(sub: WebhookSubscription) {
  return { ...sub, ...userWebhookDeliveryHealth(sub) };
}

const encoder = new TextEncoder();

type WebhookCreateInput =
  | {
      scope: "follows";
      masterKey: string;
      url: string;
      releaseType: WebhookSubscription["releaseType"];
      format: WebhookFormat;
      description: string | null;
      db: ReturnType<typeof createDb>;
    }
  | {
      scope: "org";
      masterKey: string;
      url: string;
      releaseType: WebhookSubscription["releaseType"];
      format: WebhookFormat;
      description: string | null;
      db: ReturnType<typeof createDb>;
      org: { id: string; slug: string; name: string };
      resolvedSourceId: string | null;
      resolvedProductId: string | null;
    };

meWebhookHandlers.get("/me/webhooks", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

  const enabledParam = c.req.query("enabled");
  const opts = enabledParam !== undefined ? { enabledOnly: enabledParam === "true" } : undefined;

  const db = getDb(c);
  const subscriptions = await listUserWebhookSubscriptionsEnriched(db, session.user.id, opts);
  return c.json({ subscriptions });
});

meWebhookHandlers.post("/me/webhooks", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  return idempotentPost<WebhookCreateInput>(c, {
    principal: userIdempotencyPrincipal(session.user.id),
    body: "json",
    preclaim: async () => {
      const masterKey = await requireMasterKey(c);
      if (masterKey instanceof Response) return masterKey;
      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        return respondError(c, new ValidationError("invalid JSON body", { code: "invalid_json" }));
      }
      const url = body.url;
      if (typeof url !== "string" || !url) {
        return respondError(c, new ValidationError("url is required", { code: "bad_request" }));
      }
      if (encoder.encode(url).byteLength > 2048) {
        return respondError(
          c,
          new ValidationError("url must be at most 2048 bytes", { code: "bad_request" }),
        );
      }
      const description = typeof body.description === "string" ? body.description : null;
      if (description && encoder.encode(description).byteLength > 1000) {
        return respondError(
          c,
          new ValidationError("description must be at most 1000 bytes", { code: "bad_request" }),
        );
      }
      const urlError = await assertPublicWebhookTarget(url);
      if (urlError) return respondError(c, new ValidationError(urlError, { code: "bad_request" }));

      const format: WebhookFormat = body.format === "slack" ? "slack" : "json";
      if (format === "slack") {
        const slackError = validateSlackWebhookUrl(url);
        if (slackError)
          return respondError(c, new ValidationError(slackError, { code: "bad_request" }));
      }

      const scope = body.scope === "follows" ? "follows" : "org";
      const db = getDb(c);
      if (scope === "follows") {
        const orgId = typeof body.orgId === "string" ? body.orgId : undefined;
        const orgSlug = typeof body.orgSlug === "string" ? body.orgSlug : undefined;
        const sourceId = typeof body.sourceId === "string" ? body.sourceId : undefined;
        const sourceSlug = typeof body.sourceSlug === "string" ? body.sourceSlug : undefined;
        const productId = typeof body.productId === "string" ? body.productId : undefined;
        const productSlug = typeof body.productSlug === "string" ? body.productSlug : undefined;
        if (orgId || orgSlug || sourceId || sourceSlug || productId || productSlug) {
          return respondError(
            c,
            new ValidationError(
              "follows-scoped webhooks must not include orgId, orgSlug, sourceId, sourceSlug, productId, or productSlug",
              { code: "bad_request" },
            ),
          );
        }

        const releaseTypeFilter = parseReleaseTypeFilter(body.releaseType);
        if (releaseTypeFilter === "invalid") {
          return respondError(
            c,
            new ValidationError("releaseType must be feature or rollup", { code: "bad_request" }),
          );
        }

        return {
          scope: "follows",
          masterKey,
          url,
          releaseType: releaseTypeFilter,
          format,
          description,
          db,
        };
      }

      const orgId = typeof body.orgId === "string" ? body.orgId : undefined;
      const orgSlug = typeof body.orgSlug === "string" ? body.orgSlug : undefined;
      if (!orgId && !orgSlug) {
        return respondError(
          c,
          new ValidationError("orgId or orgSlug is required", { code: "bad_request" }),
        );
      }

      const org = await resolveWebhookOrg(db, { orgId, orgSlug });
      if (!org) return respondError(c, new NotFoundError("Organization not found"));

      const sourceId = typeof body.sourceId === "string" ? body.sourceId : undefined;
      const sourceSlug = typeof body.sourceSlug === "string" ? body.sourceSlug : undefined;
      const productId = typeof body.productId === "string" ? body.productId : undefined;
      const productSlug = typeof body.productSlug === "string" ? body.productSlug : undefined;
      const releaseTypeFilter = parseReleaseTypeFilter(body.releaseType);
      if (releaseTypeFilter === "invalid") {
        return respondError(
          c,
          new ValidationError("releaseType must be feature or rollup", { code: "bad_request" }),
        );
      }

      let resolvedSourceId: string | null = null;
      let resolvedSourceProductId: string | null = null;
      if (sourceId || sourceSlug) {
        const source = await resolveWebhookSource(db, org.id, { sourceId, sourceSlug });
        if (!source) {
          return respondError(c, new NotFoundError("Source not found for this organization"));
        }
        resolvedSourceId = source.id;
        resolvedSourceProductId = source.productId;
      }

      let resolvedProductId: string | null = null;
      if (productId || productSlug) {
        const product = await resolveWebhookProduct(db, org.id, { productId, productSlug });
        if (!product) {
          return respondError(c, new NotFoundError("Product not found for this organization"));
        }
        resolvedProductId = product.id;
      }

      if (sourceProductFilterMismatch(resolvedSourceProductId, resolvedProductId)) {
        return respondError(
          c,
          new ValidationError("source does not belong to the specified product filter", {
            code: "bad_request",
          }),
        );
      }

      return {
        scope: "org",
        masterKey,
        url,
        releaseType: releaseTypeFilter,
        format,
        description,
        db,
        org,
        resolvedSourceId,
        resolvedProductId,
      };
    },
    execute: async (input) => {
      if (input.scope === "follows") {
        const existing = await getUserFollowsWebhookSubscription(input.db, session.user.id);
        if (existing) {
          return respondError(
            c,
            new RateLimitedError(
              `Maximum ${MAX_USER_FOLLOWS_WEBHOOK_SUBSCRIPTIONS} follows-scoped webhook per account`,
              { code: "limit_exceeded" },
            ),
          );
        }
      } else {
        const count = await countUserOrgWebhookSubscriptions(input.db, session.user.id);
        if (count >= MAX_USER_WEBHOOK_SUBSCRIPTIONS) {
          return respondError(
            c,
            new RateLimitedError(
              `Maximum ${MAX_USER_WEBHOOK_SUBSCRIPTIONS} org-scoped webhook subscriptions per account`,
              { code: "limit_exceeded" },
            ),
          );
        }
      }
      const sub = await insertWebhookSubscription(input.db, {
        scope: input.scope,
        orgId: input.scope === "follows" ? null : input.org.id,
        url: input.url,
        sourceId: input.scope === "follows" ? null : input.resolvedSourceId,
        productId: input.scope === "follows" ? null : input.resolvedProductId,
        releaseType: input.releaseType,
        format: input.format,
        description: input.description,
        userId: session.user.id,
      });
      const signingKey =
        input.format === "slack"
          ? undefined
          : await signingKeyFor(input.masterKey, sub.id, sub.secretVersion);
      return c.json(
        {
          ...jsonSubscription(sub),
          orgSlug: input.scope === "follows" ? null : input.org.slug,
          orgName: input.scope === "follows" ? null : input.org.name,
          ...(signingKey ? { signingKey } : {}),
        },
        201,
      );
    },
  });
});

meWebhookHandlers.get("/me/webhooks/:id", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

  const id = c.req.param("id");
  const db = getDb(c);
  const sub = await getUserWebhookSubscription(db, session.user.id, id);
  if (!sub) return respondError(c, new NotFoundError());
  return c.json(jsonSubscription(sub));
});

meWebhookHandlers.patch("/me/webhooks/:id", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return respondError(c, new ValidationError("invalid JSON body", { code: "invalid_json" }));
  }

  if (typeof body.url === "string") {
    const urlError = await assertPublicWebhookTarget(body.url);
    if (urlError) return respondError(c, new ValidationError(urlError, { code: "bad_request" }));
  }

  const basePatch = buildWebhookPatchUpdates(
    body as Partial<{
      url: string;
      description: string | null;
      enabled: boolean;
      disabledReason: string | null;
      format: WebhookFormat;
    }>,
  );
  const patch =
    "error" in basePatch
      ? ({} as import("../webhooks/queries.js").WebhookSubscriptionUpdates)
      : basePatch;
  if ("error" in basePatch && basePatch.error !== "no recognized fields to update") {
    return respondError(c, new ValidationError(basePatch.error, { code: "bad_request" }));
  }

  const id = c.req.param("id");
  const db = getDb(c);
  const owned = await getUserWebhookSubscription(db, session.user.id, id);
  if (!owned) return respondError(c, new NotFoundError());

  if (body.format === "slack" || owned.format === "slack") {
    const effectiveUrl = typeof body.url === "string" ? body.url : owned.url;
    const slackError = validateSlackWebhookUrl(effectiveUrl);
    if (slackError)
      return respondError(c, new ValidationError(slackError, { code: "bad_request" }));
  }

  if (body.releaseType !== undefined) {
    const releaseTypeFilter = parseReleaseTypeFilter(body.releaseType);
    if (releaseTypeFilter === "invalid") {
      return respondError(
        c,
        new ValidationError("releaseType must be feature or rollup", { code: "bad_request" }),
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
          return respondError(
            c,
            new ValidationError("invalid subscription", { code: "bad_request" }),
          );
        const source = await resolveWebhookSource(db, owned.orgId, { sourceId, sourceSlug });
        if (!source) {
          return respondError(c, new NotFoundError("Source not found for this organization"));
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
        return respondError(
          c,
          new ValidationError("invalid subscription", { code: "bad_request" }),
        );
      } else {
        const productId = typeof body.productId === "string" ? body.productId : undefined;
        const productSlug = typeof body.productSlug === "string" ? body.productSlug : undefined;
        const product = await resolveWebhookProduct(db, owned.orgId, { productId, productSlug });
        if (!product) {
          return respondError(c, new NotFoundError("Product not found for this organization"));
        }
        nextProductId = product.id;
      }
    }

    if (sourceProductFilterMismatch(nextSourceProductId, nextProductId)) {
      return respondError(
        c,
        new ValidationError("source does not belong to the specified product filter", {
          code: "bad_request",
        }),
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
    return respondError(
      c,
      new ValidationError(
        "follows-scoped webhooks cannot set sourceId, sourceSlug, productId, or productSlug",
        { code: "bad_request" },
      ),
    );
  }

  if (Object.keys(patch).length === 0) {
    return respondError(
      c,
      new ValidationError("no recognized fields to update", { code: "bad_request" }),
    );
  }

  const fresh = await updateWebhookSubscription(db, id, patch);
  if (!fresh) return respondError(c, new NotFoundError());
  return c.json(jsonSubscription(fresh));
});

meWebhookHandlers.delete("/me/webhooks/:id", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

  const id = c.req.param("id");
  const db = getDb(c);
  const owned = await getUserWebhookSubscription(db, session.user.id, id);
  if (!owned) return respondError(c, new NotFoundError());

  await deleteWebhookSubscription(db, id);
  return new Response(null, { status: 204 });
});

meWebhookHandlers.post("/me/webhooks/:id/rotate-secret", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  return idempotentPost(c, {
    principal: userIdempotencyPrincipal(session.user.id),
    body: "empty",
    preclaim: async () => {
      const masterKey = await requireMasterKey(c);
      if (masterKey instanceof Response) return masterKey;
      const id = c.req.param("id");
      const db = getDb(c);
      const owned = await getUserWebhookSubscription(db, session.user.id, id);
      if (!owned) return respondError(c, new NotFoundError());
      return { masterKey, id, db };
    },
    execute: async ({ masterKey, id, db }) => {
      const newVersion = await bumpWebhookSecretVersion(db, id);
      if (newVersion === null) return respondError(c, new NotFoundError());
      const signingKey = await signingKeyFor(masterKey, id, newVersion);
      return c.json({ secretVersion: newVersion, signingKey });
    },
  });
});

meWebhookHandlers.post("/me/webhooks/:id/test", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  return idempotentPost(c, {
    principal: userIdempotencyPrincipal(session.user.id),
    body: "empty",
    preclaim: async () => {
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
      const sub = await getUserWebhookSubscription(getDb(c), session.user.id, id);
      if (!sub) return respondError(c, new NotFoundError());
      return { id, queue, sub };
    },
    execute: async ({ id, queue, sub }) => {
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
        c.header("Retry-After", String(WEBHOOK_TEST_RATE_WINDOW_SECONDS));
        return respondError(c, new RateLimitedError(webhookTestRateLimitMessage(rateResult)));
      }

      const synthetic: DeliveryMessage = {
        subscriptionId: sub.id,
        url: sub.url,
        secretVersion: sub.secretVersion,
        format: sub.format,
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
    },
  });
});

meWebhookHandlers.get("/me/webhooks/:id/deliveries", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

  const id = c.req.param("id");
  const db = getDb(c);
  const owned = await getUserWebhookSubscription(db, session.user.id, id);
  if (!owned) return respondError(c, new NotFoundError());

  const result = await queryWebhookDeliveries(c.env, id, {
    failed: c.req.query("failed"),
    limit: c.req.query("limit"),
  });
  if (isReleasesError(result)) return respondError(c, result);
  return c.json(result.data);
});
