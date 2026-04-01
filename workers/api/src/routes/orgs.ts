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
      description: organizations.description,
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
        description: org.description,
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
        url: src.url,
        isPrimary: src.isPrimary ?? false,
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
  let oldestReleaseDate: string | null = null;

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
    oldestReleaseDate = totals.oldest;
  }

  const [totalReleases] = await db
    .select({ n: count() })
    .from(releases)
    .innerJoin(sources, eq(releases.sourceId, sources.id))
    .where(eq(sources.orgId, org.id));

  const [latestFetch] = await db
    .select({ maxFetch: max(sources.lastFetchedAt) })
    .from(sources)
    .where(eq(sources.orgId, org.id));

  return c.json({
    id: org.id,
    slug: org.slug,
    name: org.name,
    domain: org.domain,
    description: org.description,
    sourceCount: orgSources.length,
    releaseCount: totalReleases.n,
    releasesLast30Days,
    avgReleasesPerWeek,
    lastFetchedAt: latestFetch.maxFetch ?? null,
    trackingSince: oldestReleaseDate ?? org.createdAt,
    accounts,
    sources: sourcesWithStats,
  });
});

orgRoutes.post("/orgs", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ name: string; slug?: string; domain?: string; description?: string }>();

  if (!body.name) return c.json({ error: "bad_request", message: "Missing required field: name" }, 400);

  const slug = body.slug ?? toSlug(body.name);
  const now = new Date().toISOString();

  try {
    const [org] = await db
      .insert(organizations)
      .values({ name: body.name, slug, domain: body.domain ?? null, description: body.description ?? null, createdAt: now, updatedAt: now })
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
  const body = await c.req.json<{ name?: string; domain?: string | null; description?: string | null }>();

  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const updates: Record<string, string | null> = { updatedAt: new Date().toISOString() };
  if (body.name) updates.name = body.name;
  if (body.domain !== undefined) updates.domain = body.domain;
  if (body.description !== undefined) updates.description = body.description;

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

orgRoutes.get("/orgs/:slug/accounts", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const platform = c.req.query("platform");

  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  if (platform) {
    const [account] = await db
      .select()
      .from(orgAccounts)
      .where(and(eq(orgAccounts.orgId, org.id), eq(orgAccounts.platform, platform)));
    return c.json(account ?? null);
  }

  const accounts = await db
    .select()
    .from(orgAccounts)
    .where(eq(orgAccounts.orgId, org.id));
  return c.json(accounts);
});

orgRoutes.delete("/orgs/:slug/accounts/:platform/:handle", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const platform = c.req.param("platform");
  const handle = decodeURIComponent(c.req.param("handle"));

  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const deleted = await db
    .delete(orgAccounts)
    .where(
      and(
        eq(orgAccounts.orgId, org.id),
        eq(orgAccounts.platform, platform),
        eq(orgAccounts.handle, handle),
      ),
    )
    .returning();

  if (deleted.length === 0) {
    return c.json({ error: "not_found", message: "Account not found" }, 404);
  }

  await db
    .update(organizations)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(organizations.id, org.id));

  return c.json({ deleted: true });
});

// Weekly release activity for timeline visualization
orgRoutes.get("/orgs/:slug/activity", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  // Validate date params
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const fromParam = c.req.query("from");
  const toParam = c.req.query("to");

  if (fromParam && !dateRe.test(fromParam)) {
    return c.json({ error: "bad_request", message: "Invalid date format for 'from'. Use YYYY-MM-DD." }, 400);
  }
  if (toParam && !dateRe.test(toParam)) {
    return c.json({ error: "bad_request", message: "Invalid date format for 'to'. Use YYYY-MM-DD." }, 400);
  }
  if (fromParam && toParam && fromParam > toParam) {
    return c.json({ error: "bad_request", message: "'from' must be before 'to'." }, 400);
  }

  // Fetch all sources for this org
  const orgSources = await db
    .select({ id: sources.id, slug: sources.slug, name: sources.name })
    .from(sources)
    .where(eq(sources.orgId, org.id))
    .orderBy(sources.name);

  if (orgSources.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    return c.json({
      org: { slug: org.slug, name: org.name },
      range: { from: fromParam ?? today, to: toParam ?? today },
      sources: [],
      aggregateWeekly: [],
    });
  }

  const sourceIds = orgSources.map((s) => s.id);

  // Default range: oldest to newest release across all org sources
  let from = fromParam;
  let to = toParam;
  if (!from || !to) {
    const [bounds] = await db
      .select({ oldest: min(releases.publishedAt), newest: max(releases.publishedAt) })
      .from(releases)
      .where(and(
        inArray(releases.sourceId, sourceIds),
        sql`${releases.publishedAt} IS NOT NULL`,
        sql`(${releases.suppressed} IS NULL OR ${releases.suppressed} = 0)`,
      ));
    const today = new Date().toISOString().slice(0, 10);
    if (!from) from = bounds.oldest?.slice(0, 10) ?? today;
    if (!to) to = bounds.newest?.slice(0, 10) ?? today;
  }

  // Compute exclusive upper bound for inclusive to-date
  const toDate = new Date(to + "T00:00:00Z");
  toDate.setUTCDate(toDate.getUTCDate() + 1);
  const toExclusive = toDate.toISOString().slice(0, 10);

  const [bucketRows, statsRows, versionRows, earliestVersionRows] = await Promise.all([
    db.all<{
      source_id: string;
      week_start: string;
      cnt: number;
    }>(sql`
      SELECT
        s.id AS source_id,
        strftime('%Y-%m-%d', r.published_at, 'weekday 0', '-6 days') AS week_start,
        COUNT(*) AS cnt
      FROM releases r
      INNER JOIN sources s ON s.id = r.source_id
      WHERE
        s.org_id = ${org.id}
        AND r.published_at IS NOT NULL
        AND (r.suppressed IS NULL OR r.suppressed = 0)
        AND r.published_at >= ${from}
        AND r.published_at < ${toExclusive}
      GROUP BY s.id, week_start
      ORDER BY s.slug, week_start
    `),

    db.all<{
      source_id: string;
      total: number;
      oldest: string | null;
      latest_date: string | null;
    }>(sql`
      SELECT
        s.id AS source_id,
        COUNT(*) AS total,
        MIN(r.published_at) AS oldest,
        MAX(r.published_at) AS latest_date
      FROM releases r
      INNER JOIN sources s ON s.id = r.source_id
      WHERE
        s.org_id = ${org.id}
        AND r.published_at IS NOT NULL
        AND (r.suppressed IS NULL OR r.suppressed = 0)
        AND r.published_at >= ${from}
        AND r.published_at < ${toExclusive}
      GROUP BY s.id
    `),

    db.all<{
      source_id: string;
      version: string | null;
    }>(sql`
      SELECT r.source_id, r.version
      FROM releases r
      INNER JOIN (
        SELECT source_id, MAX(published_at) AS max_date
        FROM releases
        WHERE source_id IN ${sourceIds}
          AND (suppressed IS NULL OR suppressed = 0)
          AND published_at IS NOT NULL
          AND published_at >= ${from}
          AND published_at < ${toExclusive}
        GROUP BY source_id
      ) latest ON r.source_id = latest.source_id AND r.published_at = latest.max_date
      WHERE (r.suppressed IS NULL OR r.suppressed = 0)
    `),

    db.all<{
      source_id: string;
      version: string | null;
    }>(sql`
      SELECT r.source_id, r.version
      FROM releases r
      INNER JOIN (
        SELECT source_id, MIN(published_at) AS min_date
        FROM releases
        WHERE source_id IN ${sourceIds}
          AND (suppressed IS NULL OR suppressed = 0)
          AND published_at IS NOT NULL
          AND published_at >= ${from}
          AND published_at < ${toExclusive}
        GROUP BY source_id
      ) earliest ON r.source_id = earliest.source_id AND r.published_at = earliest.min_date
      WHERE (r.suppressed IS NULL OR r.suppressed = 0)
    `),
  ]);

  const latestVersionBySource = new Map<string, string | null>();
  for (const row of versionRows) {
    latestVersionBySource.set(row.source_id, row.version);
  }

  const earliestVersionBySource = new Map<string, string | null>();
  for (const row of earliestVersionRows) {
    earliestVersionBySource.set(row.source_id, row.version);
  }

  // Index stats and buckets by source ID
  const statsMap = new Map(statsRows.map((r) => [r.source_id, r]));
  const bucketMap = new Map<string, { weekStart: string; count: number }[]>();
  for (const row of bucketRows) {
    let arr = bucketMap.get(row.source_id);
    if (!arr) { arr = []; bucketMap.set(row.source_id, arr); }
    arr.push({ weekStart: row.week_start, count: row.cnt });
  }

  // Assemble per-source response
  const sourcesOut = orgSources.map((src) => {
    const stats = statsMap.get(src.id);
    const total = stats?.total ?? 0;
    const oldest = stats?.oldest ?? null;
    const latestDate = stats?.latest_date ?? null;

    return {
      slug: src.slug,
      name: src.name,
      releaseCount: total,
      avgReleasesPerWeek: computeAvgPerWeek(total, oldest),
      earliestVersion: earliestVersionBySource.get(src.id) ?? null,
      latestVersion: latestVersionBySource.get(src.id) ?? null,
      latestDate,
      weeklyBuckets: bucketMap.get(src.id) ?? [],
    };
  });

  // Aggregate weekly buckets across all sources
  const aggMap = new Map<string, number>();
  for (const row of bucketRows) {
    aggMap.set(row.week_start, (aggMap.get(row.week_start) ?? 0) + row.cnt);
  }
  const aggregateWeekly = Array.from(aggMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, count]) => ({ weekStart, count }));

  return c.json({
    org: { slug: org.slug, name: org.name },
    range: { from, to },
    sources: sourcesOut,
    aggregateWeekly,
  });
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
