import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { SiteNoticeResponseSchema, SiteNoticeSchema } from "@buildinternet/releases-api-types";
import { logEvent } from "@releases/lib/log-event";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { isValidBearerAuth, resolveAuthIdentity } from "../middleware/auth.js";
import { validateJson } from "../lib/validate.js";
import { getStoredSiteNotice, putStoredSiteNotice } from "../queries/site-settings.js";

export const siteNoticeRoutes = new Hono<Env>();

siteNoticeRoutes.get(
  "/site-notice",
  describeRoute({
    tags: ["Site"],
    summary: "Current site-wide notice",
    description:
      "Returns the single active site notice, or `{ notice: null }` when none is published. An admin Bearer additionally sees a stored-but-inactive (draft) notice.",
    responses: {
      200: {
        description: "The current notice or null",
        content: { "application/json": { schema: resolver(SiteNoticeResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const notice = await getStoredSiteNotice(db);
    // Public callers only see an active notice; admins also see drafts so the
    // admin form can load an unpublished notice for editing.
    if (!notice || (!notice.active && !(await isValidBearerAuth(c)))) {
      return c.json({ notice: null });
    }
    // Only the public, active notice is shared-cacheable. An inactive (draft)
    // notice only reaches here for an admin Bearer caller — never tag that
    // response `public`, or a shared/edge cache could serve an admin's draft to
    // anonymous users for up to its max-age (#1800). The header stays in-handler
    // rather than on the shared cacheControl middleware because the middleware
    // can't see the admin/draft distinction.
    if (notice.active) {
      c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    } else {
      c.header("Cache-Control", "private, no-store");
    }
    return c.json({ notice });
  },
);

siteNoticeRoutes.put(
  "/site-notice",
  describeRoute({
    tags: ["Site"],
    summary: "Publish or update the site-wide notice",
    description: "Admin only. Upserts the single site notice. Set `active: false` to hide it.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "The stored notice",
        content: { "application/json": { schema: resolver(SiteNoticeResponseSchema) } },
      },
      403: { description: "Caller lacks admin scope" },
    },
  }),
  // In-handler admin guard: root key or a token with `admin` scope. Runs even in
  // isolated route tests where the namespace auth middleware is absent.
  async (c, next) => {
    if (!(await isValidBearerAuth(c))) {
      return c.json({ error: "forbidden", message: "Admin scope required." }, 403);
    }
    await next();
  },
  validateJson(SiteNoticeSchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const previous = await getStoredSiteNotice(db);
    const notice = await putStoredSiteNotice(db, c.req.valid("json"));
    // Audit who published/changed/deactivated the site-wide notice (mirrors the
    // role-change audit). Message is public content, so it's safe to record.
    const identity = await resolveAuthIdentity(c);
    const actor =
      identity?.kind === "root"
        ? "root-key"
        : identity?.kind === "token"
          ? identity.tokenId
          : "unknown";
    logEvent("info", {
      component: "site-notice",
      event: "notice-changed",
      action: !previous ? "created" : !notice.active && previous.active ? "deactivated" : "updated",
      actor,
      active: notice.active,
      placement: notice.placement,
      message: notice.message,
    });
    return c.json({ notice });
  },
);
