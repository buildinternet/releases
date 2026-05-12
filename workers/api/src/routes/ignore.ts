import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { hideInProduction } from "../openapi.js";
import { z } from "zod";
import { eq, and, or, count, desc } from "drizzle-orm";
import { createDb } from "../db.js";
import { ignoredUrls, blockedUrls, organizations } from "@buildinternet/releases-core/schema";
import { orgWhere } from "../utils.js";
import { validateJson } from "../lib/validate.js";
import type { Env } from "../index.js";
import { buildListResponse, parseListPagination } from "../lib/pagination.js";
import {
  OrgIgnoredUrlsResponseSchema,
  AddIgnoredUrlBodySchema,
  AddIgnoredUrlResponseSchema,
  DeleteIgnoredUrlResponseSchema,
  ErrorResponseSchema,
} from "@buildinternet/releases-api-types";

/**
 * Body shape for `POST /v1/admin/blocklist`. Admin-only — kept inline
 * instead of published through `@buildinternet/releases-api-types`. The
 * blocklist itself is global (no per-org scope); a row matches either an
 * exact URL or a parent domain.
 */
const AddBlockedUrlBodySchema = z.object({
  pattern: z.string().min(1),
  type: z.enum(["exact", "domain"]).optional(),
  reason: z.string().optional(),
});

export const ignoreRoutes = new Hono<Env>();

// ── Org-scoped ignored URLs: /orgs/:slug/ignored-urls ──

ignoreRoutes.get(
  "/orgs/:slug/ignored-urls",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "List org ignored URLs",
    description:
      "Returns the org's ignored URL list as a paginated result set, ordered by `ignoredAt` descending. Pass `?url=<encoded>&single=1` to look up a single URL — returns the row or `null`. Ignored URLs are skipped during ingest so new releases from those pages are never stored. The 200 schema is a union of the paginated list (default), a single `IgnoredUrlItem` (single-mode hit), or `null` (single-mode miss).",
    parameters: [
      {
        name: "url",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "URL-encoded URL to look up. Must be combined with `?single=1`.",
      },
      {
        name: "single",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "Set to `1` with `?url=` to fetch a single row instead of the list.",
      },
    ],
    responses: {
      200: {
        description:
          "Paginated ignored-URL list (default), or a single `IgnoredUrlItem`/`null` when `?single=1` is supplied",
        content: { "application/json": { schema: resolver(OrgIgnoredUrlsResponseSchema) } },
      },
      400: {
        description: "Malformed `url` query param",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");

    const [org] = await db.select().from(organizations).where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    const singleUrl = c.req.query("url");
    if (singleUrl && c.req.query("single")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(singleUrl);
      } catch {
        return c.json(
          { error: "bad_request", message: "Malformed URL-encoded `url` query param" },
          400,
        );
      }
      const [row] = await db
        .select()
        .from(ignoredUrls)
        .where(and(eq(ignoredUrls.orgId, org.id), eq(ignoredUrls.url, decoded)));
      return c.json(row ?? null);
    }

    const pagination = parseListPagination(new URL(c.req.url).searchParams);
    const where = eq(ignoredUrls.orgId, org.id);
    const [rows, totalRow] = await Promise.all([
      db
        .select()
        .from(ignoredUrls)
        .where(where)
        .orderBy(desc(ignoredUrls.ignoredAt), desc(ignoredUrls.id))
        .limit(pagination.pageSize)
        .offset(pagination.offset),
      db.select({ n: count() }).from(ignoredUrls).where(where),
    ]);
    return c.json(buildListResponse(rows, pagination, Number(totalRow[0]?.n ?? 0)));
  },
);

ignoreRoutes.post(
  "/orgs/:slug/ignored-urls",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Add a URL to the org ignore list",
    description:
      "Adds a URL to the org's ignored list. Duplicate URLs are silently skipped (`onConflictDoNothing`). Auth is inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: "URL added to ignore list",
        content: { "application/json": { schema: resolver(AddIgnoredUrlResponseSchema) } },
      },
      400: {
        description: "Missing required field: url",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(AddIgnoredUrlBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");

    const [org] = await db.select().from(organizations).where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    const body = c.req.valid("json");
    await db
      .insert(ignoredUrls)
      .values({
        url: body.url,
        orgId: org.id,
        reason: body.reason ?? null,
        ignoredAt: new Date().toISOString(),
      })
      .onConflictDoNothing();

    return c.json({ ignored: true }, 201);
  },
);

ignoreRoutes.delete(
  "/orgs/:slug/ignored-urls/:url",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Remove a URL from the org ignore list",
    description:
      "Removes a single URL from the org's ignore list. The `:url` path segment must be URL-encoded. Succeeds even if the URL was not in the list (idempotent). Auth is inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "URL removed (or was not present)",
        content: { "application/json": { schema: resolver(DeleteIgnoredUrlResponseSchema) } },
      },
      400: {
        description: "Malformed `:url` path segment",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    let url: string;
    try {
      url = decodeURIComponent(c.req.param("url"));
    } catch {
      return c.json(
        { error: "bad_request", message: "Malformed URL-encoded `:url` path segment" },
        400,
      );
    }

    const [org] = await db.select().from(organizations).where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    await db
      .delete(ignoredUrls)
      .where(and(eq(ignoredUrls.orgId, org.id), eq(ignoredUrls.url, url)));
    return c.json({ deleted: true });
  },
);

// ── Global blocked URLs: /admin/blocklist ──

ignoreRoutes.get("/admin/blocklist", async (c) => {
  const db = createDb(c.env.DB);

  const singleUrl = c.req.query("url");
  if (singleUrl && c.req.query("single")) {
    const decoded = decodeURIComponent(singleUrl);
    let domain = "";
    try {
      domain = new URL(decoded).hostname;
    } catch {
      /* skip domain match */
    }
    const rows = await db
      .select()
      .from(blockedUrls)
      .where(
        or(
          and(eq(blockedUrls.pattern, decoded), eq(blockedUrls.type, "exact")),
          ...(domain ? [and(eq(blockedUrls.pattern, domain), eq(blockedUrls.type, "domain"))] : []),
        ),
      )
      .limit(2);
    const match = rows.find((r) => r.type === "exact") ?? rows[0] ?? null;
    return c.json(match);
  }

  const pagination = parseListPagination(new URL(c.req.url).searchParams);
  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(blockedUrls)
      .orderBy(desc(blockedUrls.createdAt), desc(blockedUrls.id))
      .limit(pagination.pageSize)
      .offset(pagination.offset),
    db.select({ n: count() }).from(blockedUrls),
  ]);
  return c.json(buildListResponse(rows, pagination, Number(totalRow[0]?.n ?? 0)));
});

ignoreRoutes.post("/admin/blocklist", validateJson(AddBlockedUrlBodySchema), async (c) => {
  const db = createDb(c.env.DB);
  const body = c.req.valid("json");

  await db
    .insert(blockedUrls)
    .values({
      pattern: body.pattern,
      type: body.type ?? "exact",
      reason: body.reason ?? null,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing();

  return c.json({ blocked: true }, 201);
});

ignoreRoutes.delete("/admin/blocklist/:pattern", async (c) => {
  const db = createDb(c.env.DB);
  const pattern = decodeURIComponent(c.req.param("pattern"));

  await db.delete(blockedUrls).where(eq(blockedUrls.pattern, pattern));
  return c.json({ deleted: true });
});
