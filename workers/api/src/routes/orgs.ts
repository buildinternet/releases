import { Hono } from "hono";
import { eq, desc, count, max, min, gte, and, sql, inArray } from "drizzle-orm";
import { createDb } from "../db.js";
import { organizations, orgAccounts, sources, releases } from "../../../../src/db/schema.js";
import { daysAgoIso } from "../../../../src/lib/dates.js";
import { toSlug } from "../../../../src/lib/slug.js";
import { isConflictError, computeAvgPerWeek } from "../utils.js";
import type { Env } from "../index.js";

export const orgRoutes = new Hono<Env>();

orgRoutes.get("/orgs", async (c) => {
  const db = createDb(c.env.DB);

  const rows = await db
    .select({
      slug: organizations.slug,
      name: organizations.name,
      domain: organizations.domain,
      id: organizations.id,
    })
    .from(organizations)
    .orderBy(organizations.name);

  const result = await Promise.all(
    rows.map(async (org) => {
      const [srcCount] = await db
        .select({ n: count() })
        .from(sources)
        .where(eq(sources.orgId, org.id));

      const [relCount] = await db
        .select({ n: count() })
        .from(releases)
        .innerJoin(sources, eq(releases.sourceId, sources.id))
        .where(eq(sources.orgId, org.id));

      const [latest] = await db
        .select({ maxDate: max(releases.publishedAt) })
        .from(releases)
        .innerJoin(sources, eq(releases.sourceId, sources.id))
        .where(and(eq(sources.orgId, org.id), sql`${releases.publishedAt} IS NOT NULL`));

      return {
        id: org.id,
        slug: org.slug,
        name: org.name,
        domain: org.domain,
        sourceCount: srcCount.n,
        releaseCount: relCount.n,
        lastActivity: latest.maxDate ?? null,
      };
    }),
  );

  return c.json(result);
});

orgRoutes.get("/orgs/:slug", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);

  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const accounts = await db
    .select({ platform: orgAccounts.platform, handle: orgAccounts.handle })
    .from(orgAccounts)
    .where(eq(orgAccounts.orgId, org.id));

  const orgSources = await db
    .select()
    .from(sources)
    .where(eq(sources.orgId, org.id))
    .orderBy(sources.name);

  const sourcesWithStats = await Promise.all(
    orgSources.map(async (src) => {
      const [relCount] = await db
        .select({ n: count() })
        .from(releases)
        .where(eq(releases.sourceId, src.id));

      const [latest] = await db
        .select({ version: releases.version, publishedAt: releases.publishedAt })
        .from(releases)
        .where(and(eq(releases.sourceId, src.id), sql`${releases.publishedAt} IS NOT NULL`))
        .orderBy(desc(releases.publishedAt))
        .limit(1);

      let latestVersion = latest?.version ?? null;
      if (!latestVersion) {
        const [fallback] = await db
          .select({ version: releases.version })
          .from(releases)
          .where(eq(releases.sourceId, src.id))
          .orderBy(desc(releases.fetchedAt))
          .limit(1);
        latestVersion = fallback?.version ?? null;
      }

      return {
        id: src.id,
        slug: src.slug,
        name: src.name,
        type: src.type,
        releaseCount: relCount.n,
        latestVersion,
        latestDate: latest?.publishedAt ?? null,
      };
    }),
  );

  // Compute org metrics inline
  const cutoff = daysAgoIso(30);
  const orgSourceIds = orgSources.map((s) => s.id);

  let releasesLast30Days = 0;
  let avgReleasesPerWeek = 0;

  if (orgSourceIds.length > 0) {
    const [recent] = await db
      .select({ n: count() })
      .from(releases)
      .where(and(inArray(releases.sourceId, orgSourceIds), gte(releases.publishedAt, cutoff)));

    const [totals] = await db
      .select({ total: count(), oldest: min(releases.publishedAt) })
      .from(releases)
      .where(and(inArray(releases.sourceId, orgSourceIds), sql`${releases.publishedAt} IS NOT NULL`));

    releasesLast30Days = recent.n;
    avgReleasesPerWeek = computeAvgPerWeek(totals.total, totals.oldest);
  }

  const [totalReleases] = await db
    .select({ n: count() })
    .from(releases)
    .innerJoin(sources, eq(releases.sourceId, sources.id))
    .where(eq(sources.orgId, org.id));

  return c.json({
    id: org.id,
    slug: org.slug,
    name: org.name,
    domain: org.domain,
    sourceCount: orgSources.length,
    releaseCount: totalReleases.n,
    releasesLast30Days,
    avgReleasesPerWeek,
    trackingSince: org.createdAt,
    accounts,
    sources: sourcesWithStats,
  });
});

orgRoutes.post("/orgs", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ name: string; slug?: string; domain?: string }>();

  if (!body.name) return c.json({ error: "bad_request", message: "Missing required field: name" }, 400);

  const slug = body.slug ?? toSlug(body.name);
  const now = new Date().toISOString();

  try {
    const [org] = await db
      .insert(organizations)
      .values({ name: body.name, slug, domain: body.domain ?? null, createdAt: now, updatedAt: now })
      .returning();
    return c.json(org, 201);
  } catch (err) {
    if (isConflictError(err)) {
      return c.json({ error: "conflict", message: `Organization with slug "${slug}" already exists` }, 409);
    }
    throw err;
  }
});

orgRoutes.patch("/orgs/:slug", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ name?: string; domain?: string }>();

  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const updates: Record<string, string> = { updatedAt: new Date().toISOString() };
  if (body.name) updates.name = body.name;
  if (body.domain !== undefined) updates.domain = body.domain;

  const [updated] = await db.update(organizations).set(updates).where(eq(organizations.id, org.id)).returning();
  return c.json(updated);
});

orgRoutes.delete("/orgs/:slug", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  await db.delete(organizations).where(eq(organizations.id, org.id));
  return c.json({ deleted: true });
});

orgRoutes.post("/orgs/:slug/accounts", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ platform: string; handle: string }>();

  if (!body.platform || !body.handle) {
    return c.json({ error: "bad_request", message: "Missing required fields: platform, handle" }, 400);
  }

  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  try {
    const [account] = await db
      .insert(orgAccounts)
      .values({ orgId: org.id, platform: body.platform, handle: body.handle, createdAt: new Date().toISOString() })
      .returning();
    return c.json(account, 201);
  } catch (err) {
    if (isConflictError(err)) {
      return c.json({ error: "conflict", message: `Account ${body.platform}/${body.handle} already exists` }, 409);
    }
    throw err;
  }
});
