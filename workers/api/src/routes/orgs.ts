import { Hono } from "hono";
import { eq, desc, count, max, min, gte, and, sql, inArray } from "drizzle-orm";
import { createDb } from "../db.js";
import { organizations, orgAccounts, sources, releases, products, tags, orgTags } from "../../../../src/db/schema.js";
import { daysAgoIso } from "../../../../src/lib/dates.js";
import { isValidCategory } from "../../../../src/lib/categories.js";
import { toSlug } from "../../../../src/lib/slug.js";
import { isConflictError, computeAvgPerWeek, getOrCreateTagD1 } from "../utils.js";
import type { Env } from "../index.js";

export const orgRoutes = new Hono<Env>();

orgRoutes.get("/orgs", async (c) => {
  const db = createDb(c.env.DB);
  const cutoff30d = daysAgoIso(30);

  const rows = await db.all<{
    id: string;
    slug: string;
    name: string;
    domain: string | null;
    description: string | null;
    category: string | null;
    source_count: number;
    release_count: number;
    last_activity: string | null;
    recent_release_count: number;
  }>(sql`
    SELECT
      o.id, o.slug, o.name, o.domain, o.description, o.category,
      (SELECT COUNT(*) FROM sources s WHERE s.org_id = o.id) AS source_count,
      (SELECT COUNT(*) FROM releases r INNER JOIN sources s ON r.source_id = s.id WHERE s.org_id = o.id AND (r.suppressed IS NULL OR r.suppressed = 0)) AS release_count,
      (SELECT MAX(r.published_at) FROM releases r INNER JOIN sources s ON r.source_id = s.id WHERE s.org_id = o.id AND r.published_at IS NOT NULL) AS last_activity,
      (SELECT COUNT(*) FROM releases r INNER JOIN sources s ON r.source_id = s.id WHERE s.org_id = o.id AND r.published_at >= ${cutoff30d} AND (r.suppressed IS NULL OR r.suppressed = 0)) AS recent_release_count
    FROM organizations o
    ORDER BY o.name
  `);

  const result = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    domain: row.domain,
    description: row.description,
    category: row.category,
    sourceCount: row.source_count,
    releaseCount: row.release_count,
    recentReleaseCount: row.recent_release_count,
    lastActivity: row.last_activity ?? null,
  }));

  return c.json(result);
});

orgRoutes.get("/orgs/:slug", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);

  const [org] = await db.select().from(organizations).where(
    slug.startsWith("org_") ? eq(organizations.id, slug) : eq(organizations.slug, slug)
  );
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const accounts = await db
    .select({ platform: orgAccounts.platform, handle: orgAccounts.handle })
    .from(orgAccounts)
    .where(eq(orgAccounts.orgId, org.id));

  const tagRows = await db
    .select({ name: tags.name })
    .from(orgTags)
    .innerJoin(tags, eq(orgTags.tagId, tags.id))
    .where(eq(orgTags.orgId, org.id))
    .orderBy(tags.name);

  const sourceRows = await db.all<{
    id: string;
    slug: string;
    name: string;
    type: string;
    url: string;
    is_primary: number | null;
    release_count: number;
    latest_version_by_date: string | null;
    latest_date: string | null;
    latest_version_by_fetch: string | null;
  }>(sql`
    SELECT
      s.id, s.slug, s.name, s.type, s.url, s.is_primary,
      (SELECT COUNT(*) FROM releases r WHERE r.source_id = s.id AND (r.suppressed IS NULL OR r.suppressed = 0)) AS release_count,
      (SELECT r2.version FROM releases r2 WHERE r2.source_id = s.id AND r2.published_at IS NOT NULL AND (r2.suppressed IS NULL OR r2.suppressed = 0) ORDER BY r2.published_at DESC LIMIT 1) AS latest_version_by_date,
      (SELECT r3.published_at FROM releases r3 WHERE r3.source_id = s.id AND r3.published_at IS NOT NULL AND (r3.suppressed IS NULL OR r3.suppressed = 0) ORDER BY r3.published_at DESC LIMIT 1) AS latest_date,
      (SELECT r4.version FROM releases r4 WHERE r4.source_id = s.id AND (r4.suppressed IS NULL OR r4.suppressed = 0) ORDER BY r4.fetched_at DESC LIMIT 1) AS latest_version_by_fetch
    FROM sources s
    WHERE s.org_id = ${org.id}
    ORDER BY s.name
  `);

  const productRows = await db
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      url: products.url,
      description: products.description,
      sourceCount: sql<number>`(SELECT COUNT(*) FROM sources s WHERE s.product_id = products.id)`,
    })
    .from(products)
    .where(eq(products.orgId, org.id))
    .orderBy(products.name);

  const orgSources = sourceRows;

  const sourcesWithStats = sourceRows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    url: row.url,
    isPrimary: row.is_primary ? true : false,
    releaseCount: row.release_count,
    latestVersion: row.latest_version_by_date ?? row.latest_version_by_fetch ?? null,
    latestDate: row.latest_date ?? null,
  }));

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
    category: org.category,
    tags: tagRows.map((t) => t.name),
    sourceCount: orgSources.length,
    releaseCount: totalReleases.n,
    releasesLast30Days,
    avgReleasesPerWeek,
    lastFetchedAt: latestFetch.maxFetch ?? null,
    trackingSince: oldestReleaseDate ?? org.createdAt,
    accounts,
    products: productRows,
    sources: sourcesWithStats,
  });
});

orgRoutes.post("/orgs", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ name: string; slug?: string; domain?: string; description?: string; category?: string; tags?: string[] }>();

  if (!body.name) return c.json({ error: "bad_request", message: "Missing required field: name" }, 400);

  if (body.category && !isValidCategory(body.category)) {
    return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
  }

  const slug = body.slug ?? toSlug(body.name);
  const now = new Date().toISOString();

  try {
    const [org] = await db
      .insert(organizations)
      .values({ name: body.name, slug, domain: body.domain ?? null, description: body.description ?? null, category: body.category ?? null, createdAt: now, updatedAt: now })
      .returning();

    if (body.tags && body.tags.length > 0) {
      for (const tagName of body.tags) {
        const tag = await getOrCreateTagD1(db, tagName);
        await db.insert(orgTags).values({ orgId: org.id, tagId: tag.id, createdAt: new Date().toISOString() }).onConflictDoNothing();
      }
    }

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
  const body = await c.req.json<{ name?: string; domain?: string | null; description?: string | null; category?: string | null; tags?: string[] }>();

  if (body.category !== undefined && body.category !== null && !isValidCategory(body.category)) {
    return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
  }

  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const updates: Record<string, string | null> = { updatedAt: new Date().toISOString() };
  if (body.name) updates.name = body.name;
  if (body.domain !== undefined) updates.domain = body.domain;
  if (body.description !== undefined) updates.description = body.description;
  if (body.category !== undefined) updates.category = body.category;

  const [updated] = await db.update(organizations).set(updates).where(eq(organizations.id, org.id)).returning();

  if (body.tags !== undefined) {
    await db.delete(orgTags).where(eq(orgTags.orgId, org.id));
    for (const tagName of body.tags) {
      const tag = await getOrCreateTagD1(db, tagName);
      await db.insert(orgTags).values({ orgId: org.id, tagId: tag.id, createdAt: new Date().toISOString() }).onConflictDoNothing();
    }
  }

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

orgRoutes.get("/orgs/:slug/tags", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const [org] = await db.select().from(organizations).where(
    slug.startsWith("org_") ? eq(organizations.id, slug) : eq(organizations.slug, slug),
  );
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const rows = await db
    .select({ name: tags.name })
    .from(orgTags)
    .innerJoin(tags, eq(orgTags.tagId, tags.id))
    .where(eq(orgTags.orgId, org.id))
    .orderBy(tags.name);
  return c.json(rows.map((r) => r.name));
});

orgRoutes.put("/orgs/:slug/tags", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ tags: string[] }>();
  const [org] = await db.select().from(organizations).where(
    slug.startsWith("org_") ? eq(organizations.id, slug) : eq(organizations.slug, slug),
  );
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  for (const tagName of body.tags) {
    const tag = await getOrCreateTagD1(db, tagName);
    await db.insert(orgTags).values({ orgId: org.id, tagId: tag.id, createdAt: new Date().toISOString() }).onConflictDoNothing();
  }
  return c.json({ ok: true });
});

orgRoutes.delete("/orgs/:slug/tags", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ tags: string[] }>();
  const [org] = await db.select().from(organizations).where(
    slug.startsWith("org_") ? eq(organizations.id, slug) : eq(organizations.slug, slug),
  );
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  for (const tagName of body.tags) {
    const tagSlug = toSlug(tagName);
    const [tag] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
    if (tag) {
      await db.delete(orgTags).where(and(eq(orgTags.orgId, org.id), eq(orgTags.tagId, tag.id)));
    }
  }
  return c.json({ ok: true });
});

orgRoutes.post("/tags", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ name: string }>();
  if (!body.name) return c.json({ error: "bad_request", message: "Missing required field: name" }, 400);

  const tagSlug = toSlug(body.name);
  const [existing] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
  if (existing) return c.json(existing);

  const [created] = await db.insert(tags).values({ name: body.name, slug: tagSlug, createdAt: new Date().toISOString() }).returning();
  return c.json(created, 201);
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
      earliest_version: string | null;
      latest_version: string | null;
    }>(sql`
      WITH bucketed AS (
        SELECT
          s.id AS source_id,
          s.slug AS source_slug,
          strftime('%Y-%m-%d', r.published_at, 'weekday 0', '-6 days') AS week_start,
          COUNT(*) AS cnt,
          MIN(CASE WHEN r.version IS NOT NULL THEN r.published_at || '|' || r.version END) AS earliest_tagged,
          MAX(CASE WHEN r.version IS NOT NULL THEN r.published_at || '|' || r.version END) AS latest_tagged
        FROM releases r
        INNER JOIN sources s ON s.id = r.source_id
        WHERE
          s.org_id = ${org.id}
          AND r.published_at IS NOT NULL
          AND (r.suppressed IS NULL OR r.suppressed = 0)
          AND r.published_at >= ${from}
          AND r.published_at < ${toExclusive}
        GROUP BY s.id, week_start
      )
      SELECT source_id, week_start, cnt,
        CASE WHEN earliest_tagged IS NOT NULL
          THEN SUBSTR(earliest_tagged, INSTR(earliest_tagged, '|') + 1)
          ELSE NULL END AS earliest_version,
        CASE WHEN latest_tagged IS NOT NULL
          THEN SUBSTR(latest_tagged, INSTR(latest_tagged, '|') + 1)
          ELSE NULL END AS latest_version
      FROM bucketed
      ORDER BY source_slug, week_start
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
  const bucketMap = new Map<string, { weekStart: string; count: number; earliestVersion: string | null; latestVersion: string | null }[]>();
  for (const row of bucketRows) {
    let arr = bucketMap.get(row.source_id);
    if (!arr) { arr = []; bucketMap.set(row.source_id, arr); }
    arr.push({
      weekStart: row.week_start,
      count: row.cnt,
      earliestVersion: row.earliest_version ?? null,
      latestVersion: row.latest_version ?? null,
    });
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

// Combined release feed for an org
orgRoutes.get("/orgs/:slug/releases", async (c) => {
  const slug = c.req.param("slug");
  const cursorParam = c.req.query("cursor") ?? null;
  const parsedLimit = parseInt(c.req.query("limit") ?? "20", 10);
  const limit = isNaN(parsedLimit) || parsedLimit < 1 ? 20 : Math.min(parsedLimit, 100);

  const db = createDb(c.env.DB);

  // Resolve org
  const org = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      slug.startsWith("org_")
        ? eq(organizations.id, slug)
        : eq(organizations.slug, slug)
    )
    .get();

  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  // Get all source IDs for this org
  const orgSources = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.orgId, org.id))
    .all();

  if (orgSources.length === 0) {
    return c.json({ releases: [], pagination: { nextCursor: null, limit } });
  }

  const sourceIds = orgSources.map((s) => s.id);
  const placeholders = sourceIds.map(() => "?").join(", ");

  // Parse cursor — format is "publishedAt|id"
  let cursorWhere = "";
  const cursorBindings: string[] = [];
  if (cursorParam) {
    const pipeIdx = cursorParam.indexOf("|");
    const cursorDate = pipeIdx > 0 ? cursorParam.slice(0, pipeIdx) : (pipeIdx === -1 ? cursorParam : "");
    const cursorId = pipeIdx >= 0 ? cursorParam.slice(pipeIdx + 1) : "";
    if (cursorDate && cursorId) {
      cursorWhere = `AND ((r.published_at < ?) OR (r.published_at = ? AND r.id < ?))`;
      cursorBindings.push(cursorDate, cursorDate, cursorId);
    } else if (cursorId) {
      // id-only cursor for releases without publishedAt
      cursorWhere = `AND (r.published_at IS NOT NULL OR r.id < ?)`;
      cursorBindings.push(cursorId);
    } else if (cursorDate) {
      cursorWhere = `AND r.published_at < ?`;
      cursorBindings.push(cursorDate);
    }
  }

  const stmt = c.env.DB.prepare(`
    SELECT r.id, r.version, r.title, r.content, r.content_summary,
           r.published_at, r.fetched_at, r.url, r.media,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type
    FROM releases r
    INNER JOIN sources s ON s.id = r.source_id
    WHERE r.source_id IN (${placeholders})
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      ${cursorWhere}
    ORDER BY
      CASE WHEN r.published_at IS NOT NULL THEN 0 ELSE 1 END,
      r.published_at DESC,
      r.fetched_at DESC,
      r.id DESC
    LIMIT ?
  `).bind(...sourceIds, ...cursorBindings, limit + 1);

  const { results } = await stmt.all<{
    id: string;
    version: string | null;
    title: string;
    content: string;
    content_summary: string | null;
    published_at: string | null;
    url: string | null;
    media: string | null;
    source_slug: string;
    source_name: string;
    source_type: string;
  }>();

  const hasMore = results.length > limit;
  const pageRows = hasMore ? results.slice(0, limit) : results;

  // Build next cursor from last item
  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = last.published_at
      ? `${last.published_at}|${last.id}`
      : `|${last.id}`;
  }

  const releasesFormatted = pageRows.map((r) => ({
    id: r.id,
    version: r.version,
    title: r.title,
    summary: r.content_summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
    content: r.content,
    publishedAt: r.published_at,
    url: r.url,
    media: (() => {
      try { return JSON.parse(r.media ?? "[]"); } catch { return []; }
    })().map((m: any) => ({
      ...m,
      r2Url: m.r2Key ? `/api/media/${m.r2Key}` : undefined,
    })),
    source: {
      slug: r.source_slug,
      name: r.source_name,
      type: r.source_type,
    },
  }));

  return c.json({
    releases: releasesFormatted,
    pagination: { nextCursor, limit },
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
