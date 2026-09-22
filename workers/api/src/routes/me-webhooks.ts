/**
 * Self-serve webhook subscription routes at `/v1/me/webhooks/*`.
 * User-owned rows carry `user_id`; the delivery pipeline is unchanged.
 */
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { createDb } from "../db.js";
import {
  insertWebhookSubscriptionCapped,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  bumpWebhookSecretVersion,
} from "../webhooks/queries.js";
import {
  buildWebhookTestEvent,
  queryWebhookDeliveries,
  requireMasterKey,
  signingKeyFor,
} from "../webhooks/shared.js";
import {
  checkWebhookTestRateLimit,
  WEBHOOK_TEST_RATE_WINDOW_SECONDS,
  webhookTestRateLimitMessage,
} from "../webhooks/test-rate-limit.js";
import {
  isUnsignedWebhookFormat,
  type WebhookSubscription,
  type WebhookFormat,
} from "@buildinternet/releases-core/schema";
import {
  getUserWebhookSubscription,
  listUserWebhookSubscriptionsEnriched,
  MAX_USER_FOLLOWS_WEBHOOK_SUBSCRIPTIONS,
  MAX_USER_WEBHOOK_SUBSCRIPTIONS,
  userWebhookDeliveryHealth,
} from "../webhooks/user-queries.js";
import { parseReleaseTypeFilter } from "../webhooks/subscription-match.js";
import {
  buildWebhookPatch,
  parseWebhookCommonFields,
  resolveOrgWebhookScopeFields,
} from "../webhooks/org-webhook-input.js";

import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { userIdempotencyPrincipal } from "../lib/idempotency-principal.js";
import { idempotentPost } from "../middleware/idempotency.js";
import { idempotentPostOpenApi } from "../lib/idempotency-openapi.js";
import { errorResponse } from "../lib/openapi-error.js";
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

const createWebhookOpenApi = idempotentPostOpenApi({
  tags: ["Webhooks"],
  summary: "Create a personal webhook subscription",
  successStatus: 201,
  successDescription: "Created webhook subscription, including its one-time signing key.",
});

meWebhookHandlers.post(
  "/me/webhooks",
  describeRoute({
    ...createWebhookOpenApi,
    responses: {
      ...createWebhookOpenApi.responses,
      400: errorResponse("Invalid url/description/scope/releaseType, or an unsafe webhook target"),
      401: errorResponse("Sign-in required"),
      404: errorResponse("Organization, source, or product not found"),
      429: errorResponse("Maximum webhook subscriptions per account reached"),
      503: errorResponse(
        "WEBHOOK_HMAC_MASTER not configured, or idempotency storage/response replay is temporarily unavailable",
      ),
    },
  }),
  async (c) => {
    const session = c.get("session");
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
    return idempotentPost<WebhookCreateInput>(c, {
      principal: userIdempotencyPrincipal(session.user.id),
      body: "json",
      preclaim: async (parsed) => {
        const masterKey = await requireMasterKey(c);
        if (masterKey instanceof Response) return masterKey;
        // Not object-checked (matches prior behavior): a non-object body
        // (e.g. `null`) falls through to the same TypeError this route has
        // always thrown on a top-level property access.
        const body = parsed as Record<string, unknown>;
        const common = await parseWebhookCommonFields(body);
        if (isReleasesError(common)) return respondError(c, common);
        const { url, format, description } = common;

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

        const scopeFields = await resolveOrgWebhookScopeFields(db, body);
        if (isReleasesError(scopeFields)) return respondError(c, scopeFields);

        return {
          scope: "org",
          masterKey,
          url,
          releaseType: scopeFields.releaseType,
          format,
          description,
          db,
          org: scopeFields.org,
          resolvedSourceId: scopeFields.resolvedSourceId,
          resolvedProductId: scopeFields.resolvedProductId,
        };
      },
      execute: async (input) => {
        const follows = input.scope === "follows";
        const sub = await insertWebhookSubscriptionCapped(
          input.db,
          { userId: session.user.id },
          {
            scope: input.scope,
            orgId: follows ? null : input.org.id,
            url: input.url,
            sourceId: follows ? null : input.resolvedSourceId,
            productId: follows ? null : input.resolvedProductId,
            releaseType: input.releaseType,
            format: input.format,
            description: input.description,
          },
          follows ? MAX_USER_FOLLOWS_WEBHOOK_SUBSCRIPTIONS : MAX_USER_WEBHOOK_SUBSCRIPTIONS,
        );
        if (!sub) {
          return respondError(
            c,
            new RateLimitedError(
              follows
                ? `Maximum ${MAX_USER_FOLLOWS_WEBHOOK_SUBSCRIPTIONS} follows-scoped webhook per account`
                : `Maximum ${MAX_USER_WEBHOOK_SUBSCRIPTIONS} org-scoped webhook subscriptions per account`,
              { code: "limit_exceeded" },
            ),
          );
        }
        const signingKey = isUnsignedWebhookFormat(input.format)
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
  },
);

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

  const id = c.req.param("id");
  const db = getDb(c);
  const owned = await getUserWebhookSubscription(db, session.user.id, id);
  if (!owned) return respondError(c, new NotFoundError());

  const patch = await buildWebhookPatch(db, owned, body);
  if (isReleasesError(patch)) return respondError(c, patch);

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

const rotateWebhookSecretOpenApi = idempotentPostOpenApi({
  tags: ["Webhooks"],
  summary: "Rotate a personal webhook signing key",
  successStatus: 200,
  successDescription: "The new secret version and one-time signing key.",
});

meWebhookHandlers.post(
  "/me/webhooks/:id/rotate-secret",
  describeRoute({
    ...rotateWebhookSecretOpenApi,
    responses: {
      ...rotateWebhookSecretOpenApi.responses,
      401: errorResponse("Sign-in required"),
      404: errorResponse("Webhook subscription not found, or not owned by the caller"),
      503: errorResponse(
        "WEBHOOK_HMAC_MASTER not configured, or idempotency storage/response replay is temporarily unavailable",
      ),
    },
  }),
  async (c) => {
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
  },
);

const testWebhookOpenApi = idempotentPostOpenApi({
  tags: ["Webhooks"],
  summary: "Queue a personal webhook test delivery",
  successStatus: 200,
  successDescription: "The queued synthetic event identifier.",
});

meWebhookHandlers.post(
  "/me/webhooks/:id/test",
  describeRoute({
    ...testWebhookOpenApi,
    responses: {
      ...testWebhookOpenApi.responses,
      401: errorResponse("Sign-in required"),
      404: errorResponse("Webhook subscription not found, or not owned by the caller"),
      429: errorResponse("Per-subscription or per-user test-delivery rate limit exceeded"),
      503: errorResponse(
        "WEBHOOK_DELIVERY_QUEUE binding missing, or idempotency storage/response replay is temporarily unavailable",
      ),
    },
  }),
  async (c) => {
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

        const synthetic = buildWebhookTestEvent(sub);

        await queue.send(synthetic);
        return c.json({ enqueued: true, eventId: synthetic.event.id });
      },
    });
  },
);

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
