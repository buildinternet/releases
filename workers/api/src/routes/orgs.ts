import { Hono } from "hono";
import { eq, count, max, min, and, sql, inArray } from "drizzle-orm";
import { createDb } from "../db.js";
import { organizations, orgAccounts, sources, releases, products, tags, orgTags, domainAliases, knowledgePages } from "@releases/db/schema.js";
import { daysAgoIso } from "@releases/lib/dates.js";
import { isValidCategory } from "@releases/lib/categories.js";
import { toSlug } from "@releases/lib/slug.js";
import { isConflictError, computeAvgPerWeek, getOrCreateTagD1, orgWhere } from "../utils.js";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { orgToMarkdown, orgReleaseFeedToMarkdown } from "@releases/lib/formatters.js";
import { assembleSourceGuide } from "@releases/ai/source-guide.js";
import type { Env } from "../index.js";
import { getOrgsWithStats, getOrgSourcesWithStats, getOrgActivityData, getOrgHeatmapData, getOrgReleasesFeed } from "../queries/orgs.js";

export const orgRoutes = new Hono<Env>();

orgRoutes.get("/orgs", async (c) => {
  const db = createDb(c.env.DB);
  const cutoff30d = daysAgoIso(30);

  const rows = await getOrgsWithStats(db, cutoff30d);

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

  let [org] = await db.select().from(organizations).where(orgWhere(slug));
  if (!org) {
    const [alias] = await db
      .select({ org: organizations })
      .from(domainAliases)
      .innerJoin(organizations, eq(domainAliases.orgId, organizations.id))
      .where(eq(domainAliases.domain, slug));
    if (alias) org = alias.org;
  }
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const cutoff = daysAgoIso(30);

  const [accounts, tagRows, orgSources, productRows, aliasRows, totalReleaseRow, latestFetchRow, knowledgeRow, sourceGuideRow] = await Promise.all([
    db
      .select({ platform: orgAccounts.platform, handle: orgAccounts.handle })
      .from(orgAccounts)
      .where(eq(orgAccounts.orgId, org.id)),

    db
      .select({ name: tags.name })
      .from(orgTags)
      .innerJoin(tags, eq(orgTags.tagId, tags.id))
      .where(eq(orgTags.orgId, org.id))
      .orderBy(tags.name),

    getOrgSourcesWithStats(db, org.id),

    db
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
      .orderBy(products.name),

    db
      .select({ domain: domainAliases.domain })
      .from(domainAliases)
      .where(eq(domainAliases.orgId, org.id))
      .orderBy(domainAliases.domain),

    // Total release count (includes suppressed — intentional for overall count)
    db
      .select({ n: count() })
      .from(releases)
      .innerJoin(sources, eq(releases.sourceId, sources.id))
      .where(eq(sources.orgId, org.id)),

    // Latest fetch timestamp across all org sources
    db
      .select({ maxFetch: max(sources.lastFetchedAt) })
      .from(sources)
      .where(eq(sources.orgId, org.id)),

    // Knowledge page for this org
    db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, org.id))),

    // Source guide for this org
    db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "source-guide"), eq(knowledgePages.orgId, org.id))),
  ]);

  const sourcesWithStats = orgSources.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    url: row.url,
    isPrimary: row.is_primary ? true : false,
    releaseCount: row.release_count,
    latestVersion: row.latest_version_by_date ?? row.latest_version_by_fetch ?? null,
    latestDate: row.latest_date ?? null,
    productSlug: row.product_slug ?? null,
    productName: row.product_name ?? null,
  }));

  const orgSourceIds = orgSources.map((s) => s.id);

  let releasesLast30Days = 0;
  let avgReleasesPerWeek = 0;
  let oldestReleaseDate: string | null = null;

  if (orgSourceIds.length > 0) {
    const [metrics] = await db
      .select({
        total: count(),
        recent: sql<number>`COUNT(CASE WHEN ${releases.publishedAt} >= ${cutoff} THEN 1 END)`,
        oldest: min(releases.publishedAt),
      })
      .from(releases)
      .where(and(inArray(releases.sourceId, orgSourceIds), sql`${releases.publishedAt} IS NOT NULL`));

    releasesLast30Days = metrics.recent;
    avgReleasesPerWeek = computeAvgPerWeek(metrics.total, metrics.oldest);
    oldestReleaseDate = metrics.oldest;
  }

  const totalReleases = totalReleaseRow[0];
  const latestFetch = latestFetchRow[0];

  const result = {
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
    aliases: aliasRows.map((a) => a.domain),
    accounts,
    products: productRows,
    sources: sourcesWithStats,
    knowledgePage: knowledgeRow[0] ? {
      scope: knowledgeRow[0].scope as "org",
      content: knowledgeRow[0].content,
      releaseCount: knowledgeRow[0].releaseCount,
      lastContributingReleaseAt: knowledgeRow[0].lastContributingReleaseAt,
      generatedAt: knowledgeRow[0].generatedAt,
      updatedAt: knowledgeRow[0].updatedAt,
    } : null,
    sourceGuide: sourceGuideRow[0] ? {
      scope: sourceGuideRow[0].scope as "source-guide",
      content: assembleSourceGuide(sourceGuideRow[0].content, sourceGuideRow[0].notes),
      updatedAt: sourceGuideRow[0].updatedAt,
    } : null,
  };

  if (wantsMarkdown(c)) {
    return markdownResponse(c, orgToMarkdown(result as any));
  }

  return c.json(result);
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
  const body = await c.req.json<{ name?: string; slug?: string; domain?: string | null; description?: string | null; category?: string | null; tags?: string[] }>();

  if (body.category !== undefined && body.category !== null && !isValidCategory(body.category)) {
    return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
  }

  const [org] = await db.select().from(organizations).where(orgWhere(slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const updates: Record<string, string | null> = { updatedAt: new Date().toISOString() };
  if (body.name) updates.name = body.name;
  if (body.slug) updates.slug = body.slug;
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

  const [org] = await db.select().from(organizations).where(orgWhere(slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  await db.delete(organizations).where(eq(organizations.id, org.id));
  return c.json({ deleted: true });
});

orgRoutes.get("/orgs/:slug/accounts", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const platform = c.req.query("platform");

  const [org] = await db.select().from(organizations).where(orgWhere(slug));
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

  const [org] = await db.select().from(organizations).where(orgWhere(slug));
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
  const [org] = await db.select().from(organizations).where(orgWhere(slug));
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
  const [org] = await db.select().from(organizations).where(orgWhere(slug));
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
  const [org] = await db.select().from(organizations).where(orgWhere(slug));
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

  const [org] = await db.select().from(organizations).where(orgWhere(slug));
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

  const { bucketRows, statsRows, latestVersionRows: versionRows, earliestVersionRows } =
    await getOrgActivityData(db, org.id, sourceIds, from, toExclusive);

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

// Daily release heatmap for contribution-graph visualization
orgRoutes.get("/orgs/:slug/heatmap", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [org] = await db.select().from(organizations).where(orgWhere(slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const today = new Date();
  const to = today.toISOString().slice(0, 10);

  const toExclusiveDate = new Date(today);
  toExclusiveDate.setUTCDate(toExclusiveDate.getUTCDate() + 1);
  const toExclusive = toExclusiveDate.toISOString().slice(0, 10);

  const fromDate = new Date(today);
  fromDate.setUTCDate(fromDate.getUTCDate() - 52 * 7);
  const from = fromDate.toISOString().slice(0, 10);

  const { rows, total } = await getOrgHeatmapData(db, org.id, from, toExclusive);

  return c.json({
    org: { slug: org.slug, name: org.name },
    range: { from, to },
    dailyCounts: rows.map((r) => ({ date: r.date, count: r.cnt })),
    total,
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
    .where(orgWhere(slug))
    .get();

  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

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

  const results = await getOrgReleasesFeed(c.env.DB, org.id, { cursorWhere, cursorBindings }, limit + 1);

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
      r2Url: m.r2Key ? `/v1/media/${m.r2Key}` : undefined,
    })),
    source: {
      slug: r.source_slug,
      name: r.source_name,
      type: r.source_type,
    },
  }));

  const pagination = { nextCursor, limit };

  if (wantsMarkdown(c)) {
    return markdownResponse(c, orgReleaseFeedToMarkdown(slug, releasesFormatted, pagination));
  }

  return c.json({ releases: releasesFormatted, pagination });
});

orgRoutes.post("/orgs/:slug/accounts", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ platform: string; handle: string }>();

  if (!body.platform || !body.handle) {
    return c.json({ error: "bad_request", message: "Missing required fields: platform, handle" }, 400);
  }

  const [org] = await db.select().from(organizations).where(orgWhere(slug));
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
