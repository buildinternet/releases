/**
 * Admin org list — the curator-facing sibling of the public `GET /v1/orgs`
 * catalog (routes/orgs.ts). Same pagination envelope, but the projection can
 * carry admin-only fields that never surface on the public route or in
 * api-types — starting with `trackingRequestedAt` (#1947 phase 2), the
 * owner-demand stamp from the self-serve listing lane
 * (`POST /v1/listing/activate`).
 *
 * Gated by `authMiddleware` via the `admin/orgs` entry in
 * route-namespaces.ts, same as admin-org-dependents.ts.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { isNotNull, desc } from "drizzle-orm";
import { organizations } from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import type { Env } from "../index.js";
import { buildListResponse, parseListPagination } from "../lib/pagination.js";

export const adminOrgsRoutes = new Hono<Env>();

function getDb(c: Context<Env>): ReturnType<typeof createDb> {
  return (c.get("db" as never) as ReturnType<typeof createDb> | undefined) ?? createDb(c.env.DB);
}

adminOrgsRoutes.get("/admin/orgs", async (c) => {
  const db = getDb(c);
  const pagination = parseListPagination(new URL(c.req.url).searchParams);
  const trackingRequestedOnly = c.req.query("trackingRequested") === "1";

  let query = db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      domain: organizations.domain,
      tier: organizations.tier,
      trackingRequestedAt: organizations.trackingRequestedAt,
    })
    .from(organizations)
    .$dynamic();

  if (trackingRequestedOnly) {
    query = query
      .where(isNotNull(organizations.trackingRequestedAt))
      .orderBy(desc(organizations.trackingRequestedAt));
  } else {
    query = query.orderBy(desc(organizations.createdAt));
  }

  const rows = await query.limit(pagination.pageSize).offset(pagination.offset);

  return c.json(buildListResponse(rows, pagination));
});
