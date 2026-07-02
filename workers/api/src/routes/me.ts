import { Hono, type Context } from "hono";
import { createDb } from "../db.js";
import { requireFollowsPrincipal } from "../middleware/auth.js";
import { parseLimitParam } from "../utils.js";
import {
  addFollow,
  removeFollow,
  listFollows,
  resolveFollowTarget,
  hasFollow,
} from "../queries/follows.js";
import {
  feedCursorFromLatestRow,
  getFollowedReleases,
  mapLatestRowToReleaseItem,
} from "../queries/releases.js";
import { FOLLOW_TARGET_TYPES, type FollowTargetType } from "../db/schema-follows.js";
import type { Env } from "../index.js";
import {
  upsertFeedToken,
  getFeedToken,
  deleteFeedToken,
  feedTokenString,
  feedAtomUrl,
} from "../queries/feed-tokens.js";
import { getDigestPrefs, setDigestCadence } from "../queries/digest-prefs.js";
import { DIGEST_CADENCES, type DigestCadence } from "../db/schema-digest-prefs.js";
import { parseJsonBody } from "../lib/json-body.js";
import type { FeedToken } from "@buildinternet/releases-api-types";
import {
  buildFeedCacheKey,
  FEED_CACHE_PAGE_SIZE,
  FEED_CACHE_TTL_SECONDS,
  invalidateUserFeedCache,
  isCacheableFeedRequest,
} from "../lib/feed-cache.js";
import { withLatestCache } from "../lib/latest-cache.js";
import { meWebhookHandlers } from "./me-webhooks.js";
import { accountProfileHandlers } from "./account-profile.js";
import { respondError } from "../lib/error-response.js";
import { UnauthorizedError, ValidationError, NotFoundError } from "@releases/lib/releases-error";

function optionalWaitUntil(c: Context<Env>): ((p: Promise<unknown>) => void) | undefined {
  try {
    return c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    return undefined;
  }
}

async function invalidateFeedCache(c: Context<Env>, userId: string): Promise<void> {
  const task = invalidateUserFeedCache(c.env.LATEST_CACHE, userId);
  const waitUntil = optionalWaitUntil(c);
  if (waitUntil) waitUntil(task);
  else await task;
}

function isFollowTargetType(v: unknown): v is FollowTargetType {
  return typeof v === "string" && (FOLLOW_TARGET_TYPES as readonly string[]).includes(v);
}

/**
 * Self-serve follow + personalized-feed handlers, defined WITHOUT auth so unit
 * tests can mount them behind an injected session (mirrors userApiKeyHandlers).
 * Production composes them under `requireFollowsPrincipal` via `meRoutes`.
 */
export const meHandlers = new Hono<Env>();

meHandlers.get("/me/follows", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  const db = createDb(c.env.DB);
  const follows = await listFollows(db, session.user.id);
  return c.json({ follows });
});

meHandlers.post("/me/follows", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  let body: { targetType?: unknown; targetId?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return respondError(c, new ValidationError("Invalid JSON body", { code: "invalid_json" }));
  }
  if (!isFollowTargetType(body.targetType) || typeof body.targetId !== "string" || !body.targetId) {
    return respondError(
      c,
      new ValidationError("targetType must be 'org' or 'product' and targetId is required", {
        code: "bad_request",
      }),
    );
  }
  const db = createDb(c.env.DB);

  // Distinguish "already following" (200) from a fresh follow (201) with a
  // single indexed existence check — addFollow's onConflictDoNothing is the
  // actual idempotency guard, so this only drives the status code.
  if (await hasFollow(db, session.user.id, body.targetType, body.targetId)) {
    return c.json({ success: true, following: true }, 200);
  }

  const entity = await resolveFollowTarget(db, body.targetType, body.targetId);
  if (!entity) return respondError(c, new NotFoundError("Target not found"));

  await addFollow(db, session.user.id, body.targetType, body.targetId);
  await invalidateFeedCache(c, session.user.id);
  return c.json({ success: true, following: true }, 201);
});

meHandlers.delete("/me/follows/:targetType/:targetId", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  const targetType = c.req.param("targetType");
  const targetId = c.req.param("targetId");
  if (!isFollowTargetType(targetType)) {
    return respondError(c, new ValidationError("Invalid targetType", { code: "bad_request" }));
  }
  const db = createDb(c.env.DB);
  await removeFollow(db, session.user.id, targetType, targetId);
  await invalidateFeedCache(c, session.user.id);
  return c.json({ success: true, following: false }, 200);
});

meHandlers.get("/me/feed", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

  const params = new URL(c.req.url).searchParams;
  if (params.has("page")) {
    return respondError(
      c,
      new ValidationError("Use ?cursor= instead of ?page=", { code: "bad_request" }),
    );
  }

  const cursor = params.get("cursor");
  const limit = parseLimitParam(params.get("limit") ?? undefined, FEED_CACHE_PAGE_SIZE, 100);
  const db = createDb(c.env.DB);
  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";

  const compute = async () => {
    const rows = await getFollowedReleases(db, session.user.id, {
      limit: limit + 1,
      cursor,
    });
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((r) => mapLatestRowToReleaseItem(r, mediaOrigin));
    const nextCursor =
      hasMore && pageRows.length > 0
        ? feedCursorFromLatestRow(pageRows[pageRows.length - 1]!)
        : null;
    return { items, pagination: { nextCursor, limit } };
  };

  c.header("Cache-Control", "private, no-store");

  if (!isCacheableFeedRequest(cursor, limit)) {
    c.header("X-Cache", "BYPASS");
    return c.json(await compute());
  }

  const { data, hit } = await withLatestCache(
    c.env.LATEST_CACHE,
    buildFeedCacheKey(session.user.id),
    optionalWaitUntil(c),
    compute,
    FEED_CACHE_TTL_SECONDS,
  );
  c.header("X-Cache", hit ? "HIT" : "MISS");
  return c.json(data);
});

/**
 * Build the absolute, tokenized feed URL from the API worker's own request
 * origin — this worker serves /v1/feed/:token, so the URL must point back at it
 * (api.releases.sh in prod; the portless host in local dev). No env dependency.
 */
function feedUrlFor(c: Context<Env>, token: string): string {
  return feedAtomUrl(new URL(c.req.url).origin, token);
}

meHandlers.get("/me/feed/token", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  const db = createDb(c.env.DB);
  const row = await getFeedToken(db, session.user.id);
  if (!row) return c.json({ token: null });
  const token: FeedToken = {
    feedUrl: feedUrlFor(c, feedTokenString(row)),
    lookupId: row.lookupId,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
  return c.json({ token });
});

meHandlers.post("/me/feed/token", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  const db = createDb(c.env.DB);
  const minted = await upsertFeedToken(db, session.user.id);
  const token: FeedToken = {
    feedUrl: feedUrlFor(c, minted.token),
    lookupId: minted.lookupId,
    createdAt: minted.createdAt.toISOString(),
    lastUsedAt: null,
  };
  return c.json(token, 201);
});

meHandlers.delete("/me/feed/token", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  const db = createDb(c.env.DB);
  await deleteFeedToken(db, session.user.id);
  return c.json({ success: true });
});

meHandlers.get("/me/digest", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  const db = createDb(c.env.DB);
  const row = await getDigestPrefs(db, session.user.id);
  return c.json({ cadence: row?.cadence ?? "off" });
});

meHandlers.put("/me/digest", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  const body = await parseJsonBody<{ cadence?: unknown }>(c);
  const cadence = body.cadence;
  if (typeof cadence !== "string" || !(DIGEST_CADENCES as readonly string[]).includes(cadence)) {
    return respondError(
      c,
      new ValidationError("cadence must be off|daily|weekly", { code: "bad_request" }),
    );
  }
  const db = createDb(c.env.DB);
  const row = await setDigestCadence(db, session.user.id, cadence as DigestCadence);
  return c.json({ cadence: row.cadence });
});

/** Production composition: session-or-Bearer principal gate, then the handlers. */
export const meRoutes = new Hono<Env>();
meRoutes.use("/me/*", requireFollowsPrincipal);
meRoutes.route("/", meHandlers);
meRoutes.route("/", meWebhookHandlers);
meRoutes.route("/", accountProfileHandlers);
