/**
 * Self-serve publish tokens (#2373): a verified domain owner mints a `relk_`
 * token bound to ONE of their org's sources, for the publish-changelog GitHub
 * Action. Cookie-session only — a `relu_` key or other Bearer credential can't
 * reach these routes, so a read-only credential can never mint a write one.
 * Gated on the self-serve listing kill switch (`listing-self-serve-enabled`),
 * the same lane that issues the ownership claims these tokens depend on.
 */
import { Hono, type Context } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import {
  CreatePublishTokenBodySchema,
  CreatedPublishTokenSchema,
  ListPublishTokensResponseSchema,
  RevokePublishTokenResponseSchema,
  type CreatedPublishToken,
  type ListPublishTokensResponse,
  type RevokePublishTokenResponse,
} from "@buildinternet/releases-api-types";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@releases/lib/releases-error";
import { logEvent } from "@releases/lib/log-event";
import { FLAGS } from "@releases/lib/flags";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { requireCookieSessionWithFlag } from "../middleware/auth.js";
import { respondError } from "../lib/error-response.js";
import { errorResponse } from "../lib/openapi-error.js";
import { validateJson } from "../lib/validate.js";
import {
  MAX_PUBLISH_TOKENS_PER_SOURCE,
  checkPublishBinding,
  listPublishTokens,
  mintPublishTokenCapped,
  revokePublishToken,
} from "../queries/publish-tokens.js";

function privateJson(c: Context<Env>, body: unknown, status: 200 | 201 = 200) {
  c.header("Cache-Control", "private, no-store");
  return c.json(body, status);
}

/**
 * No-auth-middleware handlers so unit tests can mount them behind an injected
 * session (mirrors `listingClaimHandlers`). Production composes them under
 * `mePublishTokenRoutes` below.
 */
export const mePublishTokenHandlers = new Hono<Env>();

mePublishTokenHandlers.post(
  "/me/publish-tokens",
  describeRoute({
    tags: ["Account"],
    summary: "Mint a publish token for one of your sources",
    description:
      "Signed-in (cookie session) only — Bearer credentials are not accepted. Mints a `relk_` token bound to one source, usable ONLY on that source's `POST …/releases/batch` route (e.g. from the publish-changelog GitHub Action). Requires a verified ownership claim on the source's organization; the token stops working if the claim or the source goes away. The plaintext token is returned once. At most 5 active publish tokens per source per user.",
    responses: {
      201: {
        description: "Created publish token, including the one-time secret",
        content: { "application/json": { schema: resolver(CreatedPublishTokenSchema) } },
      },
      400: errorResponse("Invalid body"),
      401: errorResponse("Sign-in required"),
      403: errorResponse("No verified ownership claim on the source's organization"),
      404: errorResponse("Lane disabled, or the source doesn't exist"),
      409: errorResponse("Maximum active publish tokens for this source reached"),
    },
  }),
  validateJson(CreatePublishTokenBodySchema),
  async (c) => {
    const session = c.get("session");
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
    const userId = session.user.id;
    const { sourceId, name } = c.req.valid("json");
    const db = createDb(c.env.DB);

    const binding = await checkPublishBinding(db, sourceId, userId);
    if (!binding.ok) {
      logEvent("info", {
        component: "publish-tokens",
        event: "publish-token-mint-denied",
        reason: binding.reason,
        userId,
        sourceId,
      });
      if (binding.reason === "claim_missing") {
        return respondError(
          c,
          new ForbiddenError(
            "A verified ownership claim on this source's organization is required.",
          ),
        );
      }
      return respondError(c, new NotFoundError("Source not found"));
    }

    const minted = await mintPublishTokenCapped(db, {
      userId,
      sourceId: binding.sourceId,
      orgId: binding.orgId,
      name,
    });
    if (!minted.ok) {
      logEvent("info", {
        component: "publish-tokens",
        event: "publish-token-mint-denied",
        reason: minted.reason,
        userId,
        sourceId,
      });
      if (minted.reason === "limit") {
        return respondError(
          c,
          new ConflictError(
            `Maximum ${MAX_PUBLISH_TOKENS_PER_SOURCE} active publish tokens per source. Revoke one first.`,
            { code: "api_key_limit" },
          ),
        );
      }
      return respondError(
        c,
        new ForbiddenError("A verified ownership claim on this source's organization is required."),
      );
    }

    logEvent("info", {
      component: "publish-tokens",
      event: "publish-token-minted",
      tokenId: minted.id,
      userId,
      sourceId: minted.sourceId,
      orgId: binding.orgId,
    });
    const body: CreatedPublishToken = {
      token: minted.token,
      id: minted.id,
      sourceId: minted.sourceId,
      name: minted.name,
      createdAt: minted.createdAt,
    };
    return privateJson(c, body, 201);
  },
);

mePublishTokenHandlers.get(
  "/me/publish-tokens",
  describeRoute({
    tags: ["Account"],
    summary: "List your publish tokens",
    description:
      "Signed-in (cookie session) only. Lists the caller's publish tokens, active and revoked, newest first. Never includes the secret.",
    responses: {
      200: {
        description: "The caller's publish tokens",
        content: { "application/json": { schema: resolver(ListPublishTokensResponseSchema) } },
      },
      401: errorResponse("Sign-in required"),
      404: errorResponse("Lane disabled"),
    },
  }),
  async (c) => {
    const session = c.get("session");
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
    const db = createDb(c.env.DB);
    const body: ListPublishTokensResponse = {
      publishTokens: await listPublishTokens(db, session.user.id),
    };
    return privateJson(c, body);
  },
);

mePublishTokenHandlers.delete(
  "/me/publish-tokens/:id",
  describeRoute({
    tags: ["Account"],
    summary: "Revoke a publish token",
    description:
      "Signed-in (cookie session) only. Revokes one of the caller's publish tokens; it stops working immediately. 404 when the id isn't a publish token the caller owns. Idempotent.",
    responses: {
      200: {
        description: "Revoked",
        content: { "application/json": { schema: resolver(RevokePublishTokenResponseSchema) } },
      },
      401: errorResponse("Sign-in required"),
      404: errorResponse("Lane disabled, or no such publish token for this caller"),
    },
  }),
  async (c) => {
    const session = c.get("session");
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
    const db = createDb(c.env.DB);
    const revoked = await revokePublishToken(db, session.user.id, c.req.param("id"));
    if (!revoked) return respondError(c, new NotFoundError("Publish token not found"));
    if (!revoked.alreadyRevoked) {
      logEvent("info", {
        component: "publish-tokens",
        event: "publish-token-revoked",
        tokenId: revoked.id,
        userId: session.user.id,
        sourceId: revoked.sourceId,
      });
    }
    const body: RevokePublishTokenResponse = { id: revoked.id, revokedAt: revoked.revokedAt };
    return privateJson(c, body);
  },
);

/** Kill switch + cookie-session gate for every publish-token route. */
export const requirePublishTokenSession = requireCookieSessionWithFlag(
  FLAGS.listingSelfServeEnabled,
  (e) => e.LISTING_SELF_SERVE_ENABLED,
);

/**
 * Production composition. MUST be mounted before `meRoutes`: its handlers
 * answer without calling `next()`, so `meRoutes`' `/me/*` session-or-Bearer
 * gate (`requireFollowsPrincipal`) never runs for these paths and can't admit
 * a `relu_` key.
 */
export const mePublishTokenRoutes = new Hono<Env>();
mePublishTokenRoutes.use("/me/publish-tokens", requirePublishTokenSession);
mePublishTokenRoutes.use("/me/publish-tokens/*", requirePublishTokenSession);
mePublishTokenRoutes.route("/", mePublishTokenHandlers);
