import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { SiteNoticeResponseSchema, SiteNoticeSchema } from "@buildinternet/releases-api-types";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { isValidBearerAuth } from "../middleware/auth.js";
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
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
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
    const notice = await putStoredSiteNotice(db, c.req.valid("json"));
    return c.json({ notice });
  },
);
