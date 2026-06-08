import { Hono } from "hono";
import { createDb } from "../db.js";
import { requireFollowsSession } from "../middleware/auth.js";
import { parseListPagination, buildListResponse } from "../lib/pagination.js";
import {
  addFollow,
  removeFollow,
  listFollows,
  resolveFollowTarget,
  hasFollow,
} from "../queries/follows.js";
import { getFollowedReleases, mapLatestRowToReleaseItem } from "../queries/releases.js";
import { FOLLOW_TARGET_TYPES, type FollowTargetType } from "../db/schema-follows.js";
import type { Env } from "../index.js";

function isFollowTargetType(v: unknown): v is FollowTargetType {
  return typeof v === "string" && (FOLLOW_TARGET_TYPES as readonly string[]).includes(v);
}

/**
 * Self-serve follow + personalized-feed handlers, defined WITHOUT auth so unit
 * tests can mount them behind an injected session (mirrors userApiKeyHandlers).
 * Production composes them under `requireFollowsSession` via `meRoutes`.
 */
export const meHandlers = new Hono<Env>();

meHandlers.get("/me/follows", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const db = createDb(c.env.DB);
  const follows = await listFollows(db, session.user.id);
  return c.json({ follows });
});

meHandlers.post("/me/follows", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  let body: { targetType?: unknown; targetId?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);
  }
  if (!isFollowTargetType(body.targetType) || typeof body.targetId !== "string" || !body.targetId) {
    return c.json(
      {
        error: "bad_request",
        message: "targetType must be 'org' or 'product' and targetId is required",
      },
      400,
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
  if (!entity) return c.json({ error: "not_found", message: "Target not found" }, 404);

  await addFollow(db, session.user.id, body.targetType, body.targetId);
  return c.json({ success: true, following: true }, 201);
});

meHandlers.delete("/me/follows/:targetType/:targetId", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const targetType = c.req.param("targetType");
  const targetId = c.req.param("targetId");
  if (!isFollowTargetType(targetType)) {
    return c.json({ error: "bad_request", message: "Invalid targetType" }, 400);
  }
  const db = createDb(c.env.DB);
  await removeFollow(db, session.user.id, targetType, targetId);
  return c.json({ success: true, following: false }, 200);
});

meHandlers.get("/me/feed", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const db = createDb(c.env.DB);
  const pagination = parseListPagination(new URL(c.req.url).searchParams, {
    defaultPageSize: 30,
    maxPageSize: 100,
  });
  const rows = await getFollowedReleases(db, session.user.id, {
    limit: pagination.pageSize,
    offset: pagination.offset,
  });
  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
  const items = rows.map((r) => mapLatestRowToReleaseItem(r, mediaOrigin));
  return c.json(buildListResponse(items, pagination));
});

/** Production composition: flag-gated session, then the handlers. */
export const meRoutes = new Hono<Env>();
meRoutes.use("/me/*", requireFollowsSession);
meRoutes.route("/", meHandlers);
