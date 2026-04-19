import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createDb } from "../db.js";
import { domainAliases, organizations } from "@releases/core-internal/schema";
import { isConflictError } from "../utils.js";
import type { Env } from "../index.js";

export const aliasRoutes = new Hono<Env>();

// List aliases filtered by orgId or productId
aliasRoutes.get("/aliases", async (c) => {
  const db = createDb(c.env.DB);
  const orgId = c.req.query("orgId");
  const productId = c.req.query("productId");

  if (orgId) {
    const rows = await db.select().from(domainAliases).where(eq(domainAliases.orgId, orgId));
    return c.json(rows);
  }
  if (productId) {
    const rows = await db.select().from(domainAliases).where(eq(domainAliases.productId, productId));
    return c.json(rows);
  }
  return c.json({ error: "bad_request", message: "Provide orgId or productId query param" }, 400);
});

// Create alias
aliasRoutes.post("/aliases", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ domain: string; orgId?: string; productId?: string }>();

  if (!body.domain) return c.json({ error: "bad_request", message: "Missing required field: domain" }, 400);
  if (!body.orgId && !body.productId) return c.json({ error: "bad_request", message: "Provide orgId or productId" }, 400);
  if (body.orgId && body.productId) return c.json({ error: "bad_request", message: "Provide orgId or productId, not both" }, 400);

  try {
    const [created] = await db
      .insert(domainAliases)
      .values({
        domain: body.domain,
        orgId: body.orgId ?? null,
        productId: body.productId ?? null,
        createdAt: new Date().toISOString(),
      })
      .returning();
    return c.json(created, 201);
  } catch (err) {
    if (isConflictError(err)) {
      return c.json({ error: "conflict", message: `Domain alias "${body.domain}" already exists` }, 409);
    }
    throw err;
  }
});

// Delete alias by domain
aliasRoutes.delete("/aliases/:domain", async (c) => {
  const db = createDb(c.env.DB);
  const domain = decodeURIComponent(c.req.param("domain"));
  const deleted = await db.delete(domainAliases).where(eq(domainAliases.domain, domain)).returning();
  if (deleted.length === 0) return c.json({ error: "not_found", message: "Alias not found" }, 404);
  return c.json({ deleted: true });
});
