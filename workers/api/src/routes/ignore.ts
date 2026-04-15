import { Hono } from "hono";
import { eq, and, or } from "drizzle-orm";
import { createDb } from "../db.js";
import { ignoredUrls, blockedUrls, organizations } from "@releases/core/schema";
import { orgWhere } from "../utils.js";
import type { Env } from "../index.js";

export const ignoreRoutes = new Hono<Env>();

// ── Org-scoped ignored URLs: /orgs/:slug/ignored-urls ──

ignoreRoutes.get("/orgs/:slug/ignored-urls", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [org] = await db.select().from(organizations).where(orgWhere(slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const singleUrl = c.req.query("url");
  if (singleUrl && c.req.query("single")) {
    const decoded = decodeURIComponent(singleUrl);
    const [row] = await db.select().from(ignoredUrls)
      .where(and(eq(ignoredUrls.orgId, org.id), eq(ignoredUrls.url, decoded)));
    return c.json(row ?? null);
  }

  const rows = await db.select().from(ignoredUrls).where(eq(ignoredUrls.orgId, org.id));
  return c.json(rows);
});

ignoreRoutes.post("/orgs/:slug/ignored-urls", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [org] = await db.select().from(organizations).where(orgWhere(slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const body = await c.req.json<{ url: string; reason?: string }>();
  if (!body.url) return c.json({ error: "bad_request", message: "Missing required field: url" }, 400);

  await db.insert(ignoredUrls).values({
    url: body.url,
    orgId: org.id,
    reason: body.reason ?? null,
    ignoredAt: new Date().toISOString(),
  }).onConflictDoNothing();

  return c.json({ ignored: true }, 201);
});

ignoreRoutes.delete("/orgs/:slug/ignored-urls/:url", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const url = decodeURIComponent(c.req.param("url"));

  const [org] = await db.select().from(organizations).where(orgWhere(slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  await db.delete(ignoredUrls)
    .where(and(eq(ignoredUrls.orgId, org.id), eq(ignoredUrls.url, url)));
  return c.json({ deleted: true });
});

// ── Global blocked URLs: /blocked-urls ──

ignoreRoutes.get("/blocked-urls", async (c) => {
  const db = createDb(c.env.DB);

  const singleUrl = c.req.query("url");
  if (singleUrl && c.req.query("single")) {
    const decoded = decodeURIComponent(singleUrl);
    let domain = "";
    try { domain = new URL(decoded).hostname; } catch { /* skip domain match */ }
    const rows = await db.select().from(blockedUrls)
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

  const rows = await db.select().from(blockedUrls);
  return c.json(rows);
});

ignoreRoutes.post("/blocked-urls", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ pattern: string; type?: "exact" | "domain"; reason?: string }>();

  if (!body.pattern) return c.json({ error: "bad_request", message: "Missing required field: pattern" }, 400);

  await db.insert(blockedUrls).values({
    pattern: body.pattern,
    type: body.type ?? "exact",
    reason: body.reason ?? null,
    createdAt: new Date().toISOString(),
  }).onConflictDoNothing();

  return c.json({ blocked: true }, 201);
});

ignoreRoutes.delete("/blocked-urls/:pattern", async (c) => {
  const db = createDb(c.env.DB);
  const pattern = decodeURIComponent(c.req.param("pattern"));

  await db.delete(blockedUrls).where(eq(blockedUrls.pattern, pattern));
  return c.json({ deleted: true });
});
