import { Hono } from "hono";
import { eq, desc, count, and, or, like, min, isNull, isNotNull, sql, gte, inArray } from "drizzle-orm";
import { createDb } from "../db.js";
import { sources, releases, organizations, releaseSummaries, products, sourceChangelogFiles, type ReleaseType } from "@releases/db/schema.js";
import { RELEASE_URL_UPSERT } from "@releases/db/release-upsert.js";
import { daysAgoIso } from "@releases/lib/dates.js";
import { toSlug } from "@releases/lib/slug.js";
import { getStatusHub, sourceWhere, orgWhere, productWhere, isConflictError, computeAvgPerWeek, heatmapDateRange, hydrateMediaUrls, resolveR2Url } from "../utils.js";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { sourceToMarkdown, releaseToMarkdown } from "@releases/lib/formatters.js";
import { fetchOne } from "../cron/poll-fetch.js";
import type { Env } from "../index.js";
import { getSourcesWithStats, getSourceReleasesPaginated, getSourceActivityBuckets, getSourceHeatmapData } from "../queries/sources.js";
import { notDisabled } from "../queries/shared.js";
import { regenerateSourceGuide } from "../source-guide-regen.js";

export const sourceRoutes = new Hono<Env>();

sourceRoutes.get("/sources", async (c) => {
  const db = createDb(c.env.DB);
  const independent = c.req.query("independent") === "true";
  const orgId = c.req.query("orgId");
  const orgSlug = c.req.query("orgSlug");
  const filterByUrls = c.req.query("filterByUrls") === "true";
  const hasFeed = c.req.query("has_feed") === "true";
  const queryText = c.req.query("query");
  const includeHidden = c.req.query("include_hidden") === "true";
  const categoryFilter = c.req.query("category");

  // Filter by URLs — return raw source rows matching the provided url params
  if (filterByUrls) {
    const urls = c.req.queries("url") ?? [];
    if (urls.length === 0) return c.json([]);
    const rows = await db.select().from(sources).where(inArray(sources.url, urls));
    return c.json(rows);
  }

  // Filter by org ID
  if (orgId) {
    const rows = await db.select().from(sources).where(eq(sources.orgId, orgId)).orderBy(sources.name);
    return c.json(rows);
  }

  // Build conditions for metadata-based filters
  const conditions = [];

  if (independent) {
    conditions.push(isNull(sources.orgId));
  }

  // Resolve org by slug
  if (orgSlug) {
    const [org] = await db.select().from(organizations).where(orgWhere(orgSlug));
    if (!org) return c.json([]);
    conditions.push(eq(sources.orgId, org.id));
  }

  const productSlug = c.req.query("productSlug");
  if (productSlug) {
    const [product] = await db.select().from(products).where(productWhere(productSlug));
    if (!product) return c.json([]);
    conditions.push(eq(sources.productId, product.id));
  }

  if (!includeHidden) {
    conditions.push(notDisabled);
  }

  if (hasFeed) {
    conditions.push(
      sql`json_extract(${sources.metadata}, '$.feedUrl') IS NOT NULL AND json_extract(${sources.metadata}, '$.feedUrl') != ''`,
    );
  }

  if (queryText) {
    const pattern = `%${queryText.toLowerCase()}%`;
    conditions.push(
      or(
        like(sql`lower(${sources.name})`, pattern),
        like(sql`lower(${sources.slug})`, pattern),
        like(sql`lower(${sources.url})`, pattern),
      )!,
    );
  }

  if (categoryFilter) {
    conditions.push(
      sql`(
        EXISTS (SELECT 1 FROM organizations o2 WHERE o2.id = ${sources.orgId} AND o2.category = ${categoryFilter})
        OR EXISTS (SELECT 1 FROM products p2 WHERE p2.id = ${sources.productId} AND p2.category = ${categoryFilter})
      )`,
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await getSourcesWithStats(db, whereClause);

  const result = rows.map((src) => ({
    id: src.id,
    slug: src.slug,
    name: src.name,
    type: src.type,
    url: src.url,
    orgSlug: src.org_slug,
    isPrimary: src.is_primary ? true : false,
    isHidden: src.is_hidden ? true : false,
    metadata: src.metadata ?? null,
    releaseCount: src.release_count,
    latestVersion: src.latest_version ?? null,
    latestDate: src.latest_date ?? null,
    lastFetchedAt: src.last_fetched_at ?? null,
    fetchPriority: src.fetch_priority ?? null,
    changeDetectedAt: src.change_detected_at ?? null,
  }));

  return c.json(result);
});

// ── Fetchable sources (must be before :slug route) ──

sourceRoutes.get("/sources/fetchable", async (c) => {
  const db = createDb(c.env.DB);
  const mode = c.req.query("mode"); // "unfetched" | "stale" | "retry_errors" | "all"
  const staleHours = c.req.query("staleHours");

  let rows: (typeof sources.$inferSelect)[];

  if (mode === "unfetched") {
    rows = await db.select().from(sources).where(and(sql`${sources.lastFetchedAt} IS NULL`, notDisabled));
  } else if (mode === "stale" && staleHours) {
    const hours = parseInt(staleHours, 10);
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    const now = new Date().toISOString();
    rows = await db.select().from(sources).where(
      and(
        sql`(${sources.lastFetchedAt} IS NULL OR ${sources.lastFetchedAt} < ${cutoff})`,
        sql`(${sources.nextFetchAfter} IS NULL OR ${sources.nextFetchAfter} <= ${now})`,
        sql`${sources.fetchPriority} != 'paused'`,
        notDisabled
      )
    );
  } else if (mode === "retry_errors") {
    rows = await db.select().from(sources).where(
      and(
        sql`${sources.id} IN (
          SELECT f.source_id FROM fetch_log f
          WHERE f.id = (SELECT f2.id FROM fetch_log f2 WHERE f2.source_id = f.source_id ORDER BY f2.created_at DESC LIMIT 1)
          AND f.status = 'error'
        )`,
        notDisabled
      )
    );
  } else {
    rows = await db.select().from(sources).where(notDisabled);
  }

  return c.json(rows);
});

// ── Feed and change-detection sources (must be before :slug route) ──

sourceRoutes.get("/sources/feeds", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(sources).where(
    and(
      sql`json_extract(${sources.metadata}, '$.feedUrl') IS NOT NULL`,
      sql`${sources.fetchPriority} != 'paused'`,
      notDisabled,
    )
  );
  return c.json(rows);
});

sourceRoutes.get("/sources/changes", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(sources).where(
    and(
      isNotNull(sources.changeDetectedAt),
      notDisabled,
    )
  );
  return c.json(rows);
});

// ── Trigger fetch for a single source ──

sourceRoutes.post("/sources/:slug/fetch", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found" }, 404);

  let responsePayload: Record<string, unknown>;

  if (src.type === "feed" || src.type === "github") {
    // Feed and GitHub sources: fetch server-side
    const githubToken = await c.env.GITHUB_TOKEN?.get();
    const sessionId = c.req.query("sessionId") ?? undefined;
    const result = await fetchOne(db, src, { GITHUB_TOKEN: githubToken }, { sessionId });
    responsePayload = { fetched: true, ...result };
  } else {
    // Scrape and agent sources: flag for CLI pickup
    await db.update(sources).set({
      changeDetectedAt: new Date().toISOString(),
    }).where(eq(sources.id, src.id));
    responsePayload = { queued: true, type: "flagged" };
  }

  // Emit status event for dashboard feedback
  const hub = getStatusHub(c.env);
  await hub.fetch(new Request("https://do/event", {
    method: "POST",
    body: JSON.stringify({
      type: "fetch:triggered",
      sourceSlug: src.slug,
      sourceName: src.name,
      sourceType: src.type,
      ...responsePayload,
    }),
    headers: { "Content-Type": "application/json" },
  }));

  return c.json(responsePayload);
});

// ── Batch release insert for fetch command ──

sourceRoutes.post("/sources/:slug/releases/batch", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json<{ releases: Array<{
    version?: string | null; title: string; content: string;
    url?: string | null; contentHash?: string; publishedAt?: string | null;
    media?: string | null; type?: ReleaseType;
  }> }>();

  try {
    // Batch insert in chunks — D1 limits query size to ~1MB
    let inserted = 0;
    for (let i = 0; i < body.releases.length; i += 5) {
      const chunk = body.releases.slice(i, i + 5).map((r) => ({
        sourceId: src.id,
        version: r.version ?? null,
        type: r.type ?? "feature",
        title: r.title,
        content: r.content,
        url: r.url ?? null,
        contentHash: r.contentHash ?? null,
        publishedAt: r.publishedAt ?? null,
        media: r.media ?? "[]",
      }));
      const rows = await db.insert(releases).values(chunk)
        .onConflictDoUpdate(RELEASE_URL_UPSERT)
        .returning({ id: releases.id });
      inserted += rows.length;
    }

    const [{ n: total }] = await db.select({ n: count() }).from(releases).where(eq(releases.sourceId, src.id));
    return c.json({ inserted, total });
  } catch (err) {
    console.error("[/sources/:slug/releases/batch] insert failed", {
      sourceId: src.id,
      slug,
      error: String(err),
      stack: (err as Error).stack,
    });
    const message = (err as Error).message ?? "Failed to insert releases";
    return c.json({ error: "insert_failed", message }, 500);
  }
});

// ── Delete all releases for a source (for --force re-fetch) ──

sourceRoutes.delete("/sources/:slug/releases", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found" }, 404);

  const deleted = await db.delete(releases).where(eq(releases.sourceId, src.id)).returning();
  return c.json({ deleted: deleted.length });
});

sourceRoutes.post("/sources/:slug/content-hash", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ contentHash: string }>();

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  if (src.lastContentHash === body.contentHash) {
    return c.json({ unchanged: true });
  }

  await db.update(sources).set({ lastContentHash: body.contentHash }).where(eq(sources.id, src.id));
  return c.json({ unchanged: false });
});

// ── Recent releases (for summary generation) ──

sourceRoutes.get("/sources/:slug/recent-releases", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const cutoff = c.req.query("cutoff");

  if (!cutoff) return c.json({ error: "cutoff query param required" }, 400);

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found" }, 404);

  const rows = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.sourceId, src.id),
        gte(releases.publishedAt, cutoff),
        eq(releases.suppressed, false),
      ),
    )
    .orderBy(desc(releases.publishedAt));

  return c.json(rows);
});

// ── Known releases for incremental parsing ──

sourceRoutes.get("/sources/:slug/known-releases", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const limit = parseInt(c.req.query("limit") ?? "10", 10);

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found" }, 404);

  const rows = await db
    .select({
      version: releases.version,
      title: releases.title,
      publishedAt: releases.publishedAt,
    })
    .from(releases)
    .where(and(eq(releases.sourceId, src.id), eq(releases.suppressed, false)))
    .orderBy(desc(releases.publishedAt))
    .limit(limit);

  return c.json(rows);
});

// ── Sessions involving a specific source slug ──

sourceRoutes.get("/sources/:slug/sessions", async (c) => {
  const slug = c.req.param("slug");
  const hub = getStatusHub(c.env);
  const res = await hub.fetch(new Request("https://do/active-sources"));
  const data = (await res.json()) as { slugs: string[]; sessionMap: Record<string, string> };
  const sessionId = data.sessionMap[slug];
  if (!sessionId) return c.json({ sessions: [] });

  const sessionRes = await hub.fetch(new Request(`https://do/sessions/${sessionId}`));
  if (sessionRes.status === 404) return c.json({ sessions: [] });
  const session = await sessionRes.json();
  return c.json({ sessions: [session] });
});

// Weekly release activity for source timeline visualization
sourceRoutes.get("/sources/:slug/activity", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

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

  const notSuppressed = sql`(r.suppressed IS NULL OR r.suppressed = 0)`;

  // Default range: oldest to newest release
  let from = fromParam;
  let to = toParam;
  if (!from || !to) {
    const [bounds] = await db.all<{ oldest: string | null; newest: string | null }>(sql`
      SELECT MIN(r.published_at) AS oldest, MAX(r.published_at) AS newest
      FROM releases r
      WHERE r.source_id = ${src.id}
        AND r.published_at IS NOT NULL
        AND ${notSuppressed}
    `);
    const today = new Date().toISOString().slice(0, 10);
    if (!from) from = bounds.oldest?.slice(0, 10) ?? today;
    if (!to) to = bounds.newest?.slice(0, 10) ?? today;
  }

  // Compute exclusive upper bound for inclusive to-date
  const toDate = new Date(to + "T00:00:00Z");
  toDate.setUTCDate(toDate.getUTCDate() + 1);
  const toExclusive = toDate.toISOString().slice(0, 10);

  const bucketRows = await getSourceActivityBuckets(db, src.id, from, toExclusive);

  let orgSlug: string | null = null;
  let orgName: string | null = null;
  if (src.orgId) {
    const [org] = await db
      .select({ slug: organizations.slug, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, src.orgId));
    if (org) { orgSlug = org.slug; orgName = org.name; }
  }

  return c.json({
    source: { slug: src.slug, name: src.name, orgSlug, orgName },
    range: { from, to },
    weeklyBuckets: bucketRows.map((r) => ({
      weekStart: r.week_start,
      count: r.cnt,
      earliestVersion: r.earliest_version ?? null,
      latestVersion: r.latest_version ?? null,
    })),
  });
});

// Daily release heatmap for source contribution-graph visualization
sourceRoutes.get("/sources/:slug/heatmap", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const { from, to, toExclusive } = heatmapDateRange();
  const { rows, total } = await getSourceHeatmapData(db, src.id, from, toExclusive);

  return c.json({
    source: { slug: src.slug, name: src.name },
    range: { from, to },
    dailyCounts: rows.map((r) => ({ date: r.date, count: r.cnt })),
    total,
  });
});

sourceRoutes.get("/sources/:slug/changelog", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);
  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);
  const [row] = await db
    .select()
    .from(sourceChangelogFiles)
    .where(eq(sourceChangelogFiles.sourceId, src.id))
    .orderBy(sourceChangelogFiles.path)
    .limit(1);
  if (!row) return c.json({ error: "not_found", message: "Changelog file not found" }, 404);
  return c.json({
    path: row.path,
    filename: row.filename,
    url: row.url,
    rawUrl: row.rawUrl,
    content: row.content,
    bytes: row.bytes,
    fetchedAt: row.fetchedAt,
  });
});

sourceRoutes.get("/sources/:slug", async (c) => {
  const slug = c.req.param("slug");
  const page = parseInt(c.req.query("page") ?? "1", 10);
  const pageSize = parseInt(c.req.query("pageSize") ?? "20", 10);
  const db = createDb(c.env.DB);

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  let org: { slug: string; name: string } | null = null;
  if (src.orgId) {
    const [orgRow] = await db
      .select({ slug: organizations.slug, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, src.orgId));
    org = orgRow ?? null;
  }

  const [relCount] = await db
    .select({ n: count() })
    .from(releases)
    .where(and(eq(releases.sourceId, src.id), eq(releases.suppressed, false)));

  const offset = (page - 1) * pageSize;
  const releaseRows = await getSourceReleasesPaginated(db, src.id, pageSize, offset);

  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
  const releasesFormatted = releaseRows.map((r) => ({
    id: r.id,
    version: r.version,
    title: r.title,
    summary:
      r.content_summary ??
      (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
    content: hydrateMediaUrls(r.content, mediaOrigin),
    publishedAt: r.published_at,
    url: r.url,
    media: JSON.parse(r.media ?? "[]").map((m: any) => ({
      ...m,
      r2Url: resolveR2Url(m.r2Key, mediaOrigin),
    })),
  }));

  const notSuppressed = sql`(${releases.suppressed} IS NULL OR ${releases.suppressed} = 0)`;

  // Derive latestVersion from already-fetched releases when on first page
  let latestVersion: string | null = null;
  let latestDate: string | null = null;

  if (page === 1 && releaseRows.length > 0) {
    // releaseRows are sorted: published_at DESC (nulls last), then fetched_at DESC
    // First row with published_at is the latest by date
    const latestByDate = releaseRows.find(r => r.published_at !== null);
    if (latestByDate?.version) {
      latestVersion = latestByDate.version;
      latestDate = latestByDate.published_at;
    }
    // Fallback: first row's version (sorted by fetched_at for null published_at rows)
    if (!latestVersion) {
      latestVersion = releaseRows[0].version ?? null;
    }
    if (!latestDate && latestByDate) {
      latestDate = latestByDate.published_at;
    }
  } else {
    // For page > 1, we still need the separate queries
    const [latest] = await db
      .select({ version: releases.version, publishedAt: releases.publishedAt })
      .from(releases)
      .where(and(eq(releases.sourceId, src.id), notSuppressed, sql`${releases.publishedAt} IS NOT NULL`))
      .orderBy(desc(releases.publishedAt))
      .limit(1);
    latestVersion = latest?.version ?? null;
    latestDate = latest?.publishedAt ?? null;
    if (!latestVersion) {
      const [fallback] = await db
        .select({ version: releases.version })
        .from(releases)
        .where(and(eq(releases.sourceId, src.id), notSuppressed))
        .orderBy(desc(releases.fetchedAt))
        .limit(1);
      latestVersion = fallback?.version ?? null;
    }
  }

  // Compute source metrics inline — use fetchedAt as fallback when publishedAt is NULL
  const cutoff = daysAgoIso(30);
  const cutoff90d = daysAgoIso(90);
  const dateCol = sql`COALESCE(${releases.publishedAt}, ${releases.fetchedAt})`;

  const [metrics] = await db
    .select({
      total: count(),
      oldest: min(dateCol),
      recent: sql<number>`COUNT(CASE WHEN ${dateCol} >= ${cutoff} THEN 1 END)`,
      recent90d: sql<number>`COUNT(CASE WHEN ${dateCol} >= ${cutoff90d} THEN 1 END)`,
    })
    .from(releases)
    .where(and(eq(releases.sourceId, src.id), notSuppressed));

  const releasesLast30Days = metrics.recent;
  const avgReleasesPerWeek = computeAvgPerWeek(metrics.recent90d, metrics.oldest);
  const totalPages = Math.ceil(relCount.n / pageSize);

  // Earliest published_at across all releases — ignores fetched_at so we reflect actual release history
  const [earliest] = await db
    .select({ date: min(releases.publishedAt) })
    .from(releases)
    .where(and(eq(releases.sourceId, src.id), notSuppressed, sql`${releases.publishedAt} IS NOT NULL`));

  // Fetch summaries for this source
  const summaryRows = await db
    .select()
    .from(releaseSummaries)
    .where(eq(releaseSummaries.sourceId, src.id))
    .orderBy(desc(releaseSummaries.generatedAt));

  const rollingSummaryRow = summaryRows.find((s) => s.type === "rolling");
  const monthlySummaryRows = summaryRows.filter((s) => s.type === "monthly");

  const parsedMeta = JSON.parse(src.metadata || "{}");

  const changelogExistsRows = await db
    .select({ one: sql<number>`1` })
    .from(sourceChangelogFiles)
    .where(eq(sourceChangelogFiles.sourceId, src.id))
    .limit(1);
  const hasChangelogFile = changelogExistsRows.length > 0;

  const result = {
    id: src.id,
    slug: src.slug,
    name: src.name,
    type: src.type,
    url: src.url,
    orgId: src.orgId,
    org,
    isPrimary: src.isPrimary ?? false,
    metadata: src.metadata ?? "{}",
    releaseCount: relCount.n,
    releasesLast30Days,
    avgReleasesPerWeek,
    latestVersion,
    latestDate,
    changelogUrl: parsedMeta.changelogUrl ?? null,
    hasChangelogFile,
    lastFetchedAt: src.lastFetchedAt,
    trackingSince: earliest?.date ?? metrics.oldest ?? src.createdAt,
    releases: releasesFormatted,
    pagination: { page, pageSize, totalPages, totalItems: relCount.n },
    summaries: {
      rolling: rollingSummaryRow
        ? { windowDays: rollingSummaryRow.windowDays, summary: rollingSummaryRow.summary, releaseCount: rollingSummaryRow.releaseCount, generatedAt: rollingSummaryRow.generatedAt }
        : null,
      monthly: monthlySummaryRows.map((s) => ({
        year: s.year, month: s.month, summary: s.summary, releaseCount: s.releaseCount, generatedAt: s.generatedAt,
      })),
    },
  };

  if (wantsMarkdown(c)) {
    return markdownResponse(c, sourceToMarkdown(result as any));
  }

  return c.json(result);
});

sourceRoutes.post("/sources", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{
    name: string; url: string; type?: string; slug?: string;
    orgId?: string; orgSlug?: string; metadata?: string;
  }>();

  if (!body.name || !body.url) {
    return c.json({ error: "bad_request", message: "Missing required fields: name, url" }, 400);
  }

  const slug = body.slug ?? toSlug(body.name);

  // Auto-detect feed type when metadata contains a feedUrl and no explicit type was provided
  let type = body.type ?? "scrape";
  if (!body.type && body.metadata) {
    try {
      const meta = JSON.parse(body.metadata);
      if (meta.feedUrl) type = "feed";
    } catch { /* invalid metadata JSON — ignore */ }
  }

  // Resolve org by slug if orgSlug provided (preferred over raw orgId)
  let orgId = body.orgId ?? null;
  if (!orgId && body.orgSlug) {
    const [org] = await db.select().from(organizations).where(orgWhere(body.orgSlug));
    orgId = org?.id ?? null;
  }

  try {
    const [source] = await db
      .insert(sources)
      .values({
        name: body.name,
        slug,
        type: type as "github" | "scrape" | "feed" | "agent",
        url: body.url,
        orgId,
        metadata: body.metadata ?? "{}",
        createdAt: new Date().toISOString(),
      })
      .returning();
    if (orgId) c.executionCtx.waitUntil(regenerateSourceGuide(db, orgId));
    return c.json(source, 201);
  } catch (err) {
    if (isConflictError(err)) {
      return c.json({ error: "conflict", message: `Source with slug "${slug}" already exists` }, 409);
    }
    throw err;
  }
});

sourceRoutes.patch("/sources/:slug", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<{
    name?: string; url?: string; type?: string; metadata?: string; orgId?: string | null;
    productId?: string | null;
    lastFetchedAt?: string | null; lastContentHash?: string | null;
    fetchPriority?: string; consecutiveNoChange?: number;
    consecutiveErrors?: number; nextFetchAfter?: string | null;
    isPrimary?: boolean;
    isHidden?: boolean;
    changeDetectedAt?: string | null;
    lastPolledAt?: string | null;
  }>();

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.url !== undefined) updates.url = body.url;
  if (body.type !== undefined) updates.type = body.type;
  if (body.metadata !== undefined) updates.metadata = body.metadata;
  if (body.orgId !== undefined) updates.orgId = body.orgId;
  if (body.productId !== undefined) updates.productId = body.productId;
  if (body.lastFetchedAt !== undefined) updates.lastFetchedAt = body.lastFetchedAt;
  if (body.lastContentHash !== undefined) updates.lastContentHash = body.lastContentHash;
  if (body.fetchPriority !== undefined) updates.fetchPriority = body.fetchPriority;
  if (body.consecutiveNoChange !== undefined) updates.consecutiveNoChange = body.consecutiveNoChange;
  if (body.consecutiveErrors !== undefined) updates.consecutiveErrors = body.consecutiveErrors;
  if (body.nextFetchAfter !== undefined) updates.nextFetchAfter = body.nextFetchAfter;
  if (body.isPrimary !== undefined) updates.isPrimary = body.isPrimary;
  if (body.isHidden !== undefined) updates.isHidden = body.isHidden;
  if (body.changeDetectedAt !== undefined) updates.changeDetectedAt = body.changeDetectedAt;
  if (body.lastPolledAt !== undefined) updates.lastPolledAt = body.lastPolledAt;

  const [updated] = await db.update(sources).set(updates).where(eq(sources.id, src.id)).returning();
  if (src.orgId) c.executionCtx.waitUntil(regenerateSourceGuide(db, src.orgId));
  return c.json(updated);
});

sourceRoutes.delete("/sources/:slug", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const orgId = src.orgId;
  await db.delete(sources).where(eq(sources.id, src.id));
  if (orgId) c.executionCtx.waitUntil(regenerateSourceGuide(db, orgId));
  return c.json({ deleted: true });
});

// Bulk release insert for data seeding
sourceRoutes.post("/sources/:slug/releases", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const body = await c.req.json<{
    id?: string; version?: string; title: string; content: string;
    contentSummary?: string; url?: string; contentHash?: string;
    metadata?: string; publishedAt?: string; fetchedAt?: string;
    type?: ReleaseType;
  }>();

  try {
    const [release] = await db
      .insert(releases)
      .values({
        id: body.id,
        sourceId: src.id,
        version: body.version ?? null,
        type: body.type ?? "feature",
        title: body.title,
        content: body.content,
        contentSummary: body.contentSummary ?? null,
        url: body.url ?? null,
        contentHash: body.contentHash ?? null,
        metadata: body.metadata ?? "{}",
        publishedAt: body.publishedAt ?? null,
        fetchedAt: body.fetchedAt ?? new Date().toISOString(),
      })
      .onConflictDoNothing()
      .returning();
    return c.json(release ?? { skipped: true }, release ? 201 : 200);
  } catch (err) {
    return c.json({ error: "insert_failed", message: "Failed to insert release" }, 500);
  }
});

// ── Release CRUD ──

sourceRoutes.get("/releases/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");

  const rows = await db
    .select({
      release: releases,
      sourceName: sources.name,
      sourceSlug: sources.slug,
      sourceType: sources.type,
      orgSlug: organizations.slug,
      orgName: organizations.name,
    })
    .from(releases)
    .leftJoin(sources, eq(releases.sourceId, sources.id))
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .where(eq(releases.id, id));

  if (rows.length === 0) return c.json({ error: "not_found", message: "Release not found" }, 404);

  const { release, sourceName, sourceSlug, sourceType, orgSlug, orgName } = rows[0];
  const org = orgSlug && orgName ? { slug: orgSlug, name: orgName } : null;
  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";

  const media = JSON.parse((release.media as string) ?? "[]").map((m: any) => ({
    ...m,
    r2Url: resolveR2Url(m.r2Key, mediaOrigin),
  }));

  const hydratedContent = hydrateMediaUrls(release.content as string, mediaOrigin);
  const result = { ...release, content: hydratedContent, media, sourceName, sourceSlug, sourceType, org };

  if (wantsMarkdown(c)) {
    return markdownResponse(c, releaseToMarkdown(result as any));
  }

  return c.json(result);
});

sourceRoutes.delete("/releases/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");

  const deleted = await db.delete(releases).where(eq(releases.id, id)).returning({ id: releases.id });
  if (deleted.length === 0) return c.json({ error: "not_found", message: "Release not found" }, 404);

  return c.json({ deleted: true });
});

sourceRoutes.patch("/releases/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    title?: string; version?: string; content?: string;
    url?: string; publishedAt?: string; contentHash?: string;
  }>();

  const [existing] = await db.select().from(releases).where(eq(releases.id, id));
  if (!existing) return c.json({ error: "not_found", message: "Release not found" }, 404);

  const updates: Record<string, unknown> = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.version !== undefined) updates.version = body.version;
  if (body.content !== undefined) updates.content = body.content;
  if (body.url !== undefined) updates.url = body.url;
  if (body.publishedAt !== undefined) updates.publishedAt = body.publishedAt;
  if (body.contentHash !== undefined) updates.contentHash = body.contentHash;

  const [updated] = await db.update(releases).set(updates).where(eq(releases.id, id)).returning();
  return c.json(updated);
});

// ── Release suppression ──

sourceRoutes.post("/releases/:id/suppress", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}));

  const [updated] = await db.update(releases).set({
    suppressed: true,
    suppressedReason: (body as { reason?: string }).reason ?? null,
  }).where(eq(releases.id, id)).returning({ id: releases.id });

  if (!updated) return c.json({ error: "not_found", message: "Release not found" }, 404);
  return c.json({ suppressed: true });
});

sourceRoutes.post("/releases/:id/unsuppress", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");

  const [updated] = await db.update(releases).set({
    suppressed: false,
    suppressedReason: null,
  }).where(eq(releases.id, id)).returning({ id: releases.id });

  if (!updated) return c.json({ error: "not_found", message: "Release not found" }, 404);
  return c.json({ unsuppressed: true });
});
