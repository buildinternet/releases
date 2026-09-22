/**
 * Workspace-owned webhook subscription routes at
 * `/v1/workspaces/:workspaceId/webhooks/*`. Mirrors `/v1/me/webhooks`
 * (see `me-webhooks.ts`) but rows carry `workspace_id` instead of `user_id`
 * and are org-scoped only — there is no workspace "follows" scope. Owners
 * and admins (`requireWorkspaceManager`) create/edit/rotate/delete; any
 * member (`requireWorkspaceMember`) can list, read, test, and view
 * deliveries. A non-member gets a 404 (existence isn't leaked); a member
 * without manage rights gets a 403.
 */
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { createDb } from "../db.js";
import {
  insertWebhookSubscription,
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
} from "@buildinternet/releases-core/schema";
import {
  countWorkspaceWebhookSubscriptions,
  getWorkspaceWebhookSubscription,
  listWorkspaceWebhookSubscriptionsEnriched,
  MAX_WORKSPACE_WEBHOOK_SUBSCRIPTIONS,
  userWebhookDeliveryHealth,
} from "../webhooks/user-queries.js";
import {
  buildWebhookPatch,
  parseWebhookCommonFields,
  resolveOrgWebhookScopeFields,
} from "../webhooks/org-webhook-input.js";
import {
  requireWorkspaceManager,
  requireWorkspaceMember,
  workspaceGateError,
} from "../lib/workspace-access.js";

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

export const workspaceWebhookHandlers = new Hono<Env>();

function getDb(c: { env: Env["Bindings"]; get: (k: "db") => unknown }) {
  return (c.get("db") as ReturnType<typeof createDb> | undefined) ?? createDb(c.env.DB);
}

function jsonSubscription(sub: WebhookSubscription) {
  return { ...sub, ...userWebhookDeliveryHealth(sub) };
}

interface WebhookCreateInput {
  masterKey: string;
  url: string;
  releaseType: WebhookSubscription["releaseType"];
  format: WebhookSubscription["format"];
  description: string | null;
  db: ReturnType<typeof createDb>;
  workspaceId: string;
  org: { id: string; slug: string; name: string };
  resolvedSourceId: string | null;
  resolvedProductId: string | null;
}

workspaceWebhookHandlers.get("/workspaces/:workspaceId/webhooks", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

  const workspaceId = c.req.param("workspaceId");
  const db = getDb(c);
  const member = await requireWorkspaceMember(db, session.user.id, workspaceId);
  if (!member.ok) return respondError(c, workspaceGateError(member));

  const enabledParam = c.req.query("enabled");
  const opts = enabledParam !== undefined ? { enabledOnly: enabledParam === "true" } : undefined;

  const subscriptions = await listWorkspaceWebhookSubscriptionsEnriched(db, workspaceId, opts);
  return c.json({
    subscriptions,
    role: member.role,
    canManage: member.role === "owner" || member.role === "admin",
  });
});

const createWorkspaceWebhookOpenApi = idempotentPostOpenApi({
  tags: ["Webhooks"],
  summary: "Create a workspace webhook subscription",
  successStatus: 201,
  successDescription: "Created webhook subscription, including its one-time signing key.",
});

workspaceWebhookHandlers.post(
  "/workspaces/:workspaceId/webhooks",
  describeRoute({
    ...createWorkspaceWebhookOpenApi,
    responses: {
      ...createWorkspaceWebhookOpenApi.responses,
      400: errorResponse("Invalid url/description/scope/releaseType, or an unsafe webhook target"),
      401: errorResponse("Sign-in required"),
      403: errorResponse("Workspace owner or admin required"),
      404: errorResponse("Workspace, organization, source, or product not found"),
      429: errorResponse("Maximum webhook subscriptions per workspace reached"),
      503: errorResponse(
        "WEBHOOK_HMAC_MASTER not configured, or idempotency storage/response replay is temporarily unavailable",
      ),
    },
  }),
  async (c) => {
    const session = c.get("session");
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
    const workspaceId = c.req.param("workspaceId");
    return idempotentPost<WebhookCreateInput>(c, {
      principal: userIdempotencyPrincipal(session.user.id),
      body: "json",
      preclaim: async (parsed) => {
        const db = getDb(c);
        const gate = await requireWorkspaceManager(db, session.user.id, workspaceId);
        if (!gate.ok) return respondError(c, workspaceGateError(gate));

        const masterKey = await requireMasterKey(c);
        if (masterKey instanceof Response) return masterKey;

        const body = parsed as Record<string, unknown>;
        if (body.scope === "follows") {
          return respondError(
            c,
            new ValidationError('workspace webhooks must be org-scoped (scope: "org")', {
              code: "bad_request",
            }),
          );
        }

        const common = await parseWebhookCommonFields(body);
        if (isReleasesError(common)) return respondError(c, common);
        const { url, format, description } = common;

        const scopeFields = await resolveOrgWebhookScopeFields(db, body);
        if (isReleasesError(scopeFields)) return respondError(c, scopeFields);

        return {
          masterKey,
          url,
          releaseType: scopeFields.releaseType,
          format,
          description,
          db,
          workspaceId,
          org: scopeFields.org,
          resolvedSourceId: scopeFields.resolvedSourceId,
          resolvedProductId: scopeFields.resolvedProductId,
        };
      },
      execute: async (input) => {
        const count = await countWorkspaceWebhookSubscriptions(input.db, input.workspaceId);
        if (count >= MAX_WORKSPACE_WEBHOOK_SUBSCRIPTIONS) {
          return respondError(
            c,
            new RateLimitedError(
              `Maximum ${MAX_WORKSPACE_WEBHOOK_SUBSCRIPTIONS} webhook subscriptions per workspace`,
              { code: "limit_exceeded" },
            ),
          );
        }

        const sub = await insertWebhookSubscription(input.db, {
          scope: "org",
          orgId: input.org.id,
          url: input.url,
          sourceId: input.resolvedSourceId,
          productId: input.resolvedProductId,
          releaseType: input.releaseType,
          format: input.format,
          description: input.description,
          workspaceId: input.workspaceId,
        });
        const signingKey = isUnsignedWebhookFormat(input.format)
          ? undefined
          : await signingKeyFor(input.masterKey, sub.id, sub.secretVersion);
        return c.json(
          {
            ...jsonSubscription(sub),
            orgSlug: input.org.slug,
            orgName: input.org.name,
            ...(signingKey ? { signingKey } : {}),
          },
          201,
        );
      },
    });
  },
);

workspaceWebhookHandlers.get("/workspaces/:workspaceId/webhooks/:id", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

  const workspaceId = c.req.param("workspaceId");
  const db = getDb(c);
  const member = await requireWorkspaceMember(db, session.user.id, workspaceId);
  if (!member.ok) return respondError(c, workspaceGateError(member));

  const id = c.req.param("id");
  const sub = await getWorkspaceWebhookSubscription(db, workspaceId, id);
  if (!sub) return respondError(c, new NotFoundError());
  return c.json(jsonSubscription(sub));
});

workspaceWebhookHandlers.patch("/workspaces/:workspaceId/webhooks/:id", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

  const workspaceId = c.req.param("workspaceId");
  const db = getDb(c);
  const gate = await requireWorkspaceManager(db, session.user.id, workspaceId);
  if (!gate.ok) return respondError(c, workspaceGateError(gate));

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return respondError(c, new ValidationError("invalid JSON body", { code: "invalid_json" }));
  }

  const id = c.req.param("id");
  const owned = await getWorkspaceWebhookSubscription(db, workspaceId, id);
  if (!owned) return respondError(c, new NotFoundError());

  // Workspace webhooks are always org-scoped — the shared patch builder's
  // org-scope branch (resolveOrgWebhookPatchFilters) always applies here.
  const patch = await buildWebhookPatch(db, owned, body);
  if (isReleasesError(patch)) return respondError(c, patch);

  const fresh = await updateWebhookSubscription(db, id, patch);
  if (!fresh) return respondError(c, new NotFoundError());
  return c.json(jsonSubscription(fresh));
});

workspaceWebhookHandlers.delete("/workspaces/:workspaceId/webhooks/:id", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

  const workspaceId = c.req.param("workspaceId");
  const db = getDb(c);
  const gate = await requireWorkspaceManager(db, session.user.id, workspaceId);
  if (!gate.ok) return respondError(c, workspaceGateError(gate));

  const id = c.req.param("id");
  const owned = await getWorkspaceWebhookSubscription(db, workspaceId, id);
  if (!owned) return respondError(c, new NotFoundError());

  await deleteWebhookSubscription(db, id);
  return new Response(null, { status: 204 });
});

const rotateWorkspaceWebhookSecretOpenApi = idempotentPostOpenApi({
  tags: ["Webhooks"],
  summary: "Rotate a workspace webhook signing key",
  successStatus: 200,
  successDescription: "The new secret version and one-time signing key.",
});

workspaceWebhookHandlers.post(
  "/workspaces/:workspaceId/webhooks/:id/rotate-secret",
  describeRoute({
    ...rotateWorkspaceWebhookSecretOpenApi,
    responses: {
      ...rotateWorkspaceWebhookSecretOpenApi.responses,
      401: errorResponse("Sign-in required"),
      403: errorResponse("Workspace owner or admin required"),
      404: errorResponse("Webhook subscription not found, or not owned by this workspace"),
      503: errorResponse(
        "WEBHOOK_HMAC_MASTER not configured, or idempotency storage/response replay is temporarily unavailable",
      ),
    },
  }),
  async (c) => {
    const session = c.get("session");
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
    const workspaceId = c.req.param("workspaceId");
    return idempotentPost(c, {
      principal: userIdempotencyPrincipal(session.user.id),
      body: "empty",
      preclaim: async () => {
        const db = getDb(c);
        const gate = await requireWorkspaceManager(db, session.user.id, workspaceId);
        if (!gate.ok) return respondError(c, workspaceGateError(gate));

        const masterKey = await requireMasterKey(c);
        if (masterKey instanceof Response) return masterKey;
        const id = c.req.param("id");
        const owned = await getWorkspaceWebhookSubscription(db, workspaceId, id);
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

const testWorkspaceWebhookOpenApi = idempotentPostOpenApi({
  tags: ["Webhooks"],
  summary: "Queue a workspace webhook test delivery",
  successStatus: 200,
  successDescription: "The queued synthetic event identifier.",
});

workspaceWebhookHandlers.post(
  "/workspaces/:workspaceId/webhooks/:id/test",
  describeRoute({
    ...testWorkspaceWebhookOpenApi,
    responses: {
      ...testWorkspaceWebhookOpenApi.responses,
      401: errorResponse("Sign-in required"),
      404: errorResponse("Webhook subscription not found, or not owned by this workspace"),
      429: errorResponse("Per-subscription or per-user test-delivery rate limit exceeded"),
      503: errorResponse(
        "WEBHOOK_DELIVERY_QUEUE binding missing, or idempotency storage/response replay is temporarily unavailable",
      ),
    },
  }),
  async (c) => {
    const session = c.get("session");
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
    const workspaceId = c.req.param("workspaceId");
    return idempotentPost(c, {
      principal: userIdempotencyPrincipal(session.user.id),
      body: "empty",
      preclaim: async () => {
        const db = getDb(c);
        const member = await requireWorkspaceMember(db, session.user.id, workspaceId);
        if (!member.ok) return respondError(c, workspaceGateError(member));

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
        const sub = await getWorkspaceWebhookSubscription(db, workspaceId, id);
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

workspaceWebhookHandlers.get("/workspaces/:workspaceId/webhooks/:id/deliveries", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

  const workspaceId = c.req.param("workspaceId");
  const db = getDb(c);
  const member = await requireWorkspaceMember(db, session.user.id, workspaceId);
  if (!member.ok) return respondError(c, workspaceGateError(member));

  const id = c.req.param("id");
  const owned = await getWorkspaceWebhookSubscription(db, workspaceId, id);
  if (!owned) return respondError(c, new NotFoundError());

  const result = await queryWebhookDeliveries(c.env, id, {
    failed: c.req.query("failed"),
    limit: c.req.query("limit"),
  });
  if (isReleasesError(result)) return respondError(c, result);
  return c.json(result.data);
});
