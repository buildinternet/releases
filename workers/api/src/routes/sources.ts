import { Hono } from "hono";
import { eq, desc, count, and, or, like, min, isNull, isNotNull, sql, gte, inArray } from "drizzle-orm";
import { createDb } from "../db.js";
import { sources, releases, organizations, fetchLog, releaseSummaries } from "../../../../src/db/schema.js";
import { daysAgoIso } from "../../../../src/lib/dates.js";
import { toSlug } from "../../../../src/lib/slug.js";
import { getStatusHub } from "../utils.js";
import { isConflictError, computeAvgPerWeek } from "../utils.js";
import type { Env } from "../index.js";

export const sourceRoutes = new Hono<Env>();

sourceRoutes.get("/sources", async (c) => {
  const db = createDb(c.env.DB);
  const independent = c.req.query("independent") === "true";
  const orgId = c.req.query("orgId");
  const orgSlug = c.req.query("orgSlug");
  const filterByUrls = c.req.query("filterByUrls") === "true";
  const hasFeed = c.req.query("has_feed") === "true";
  const enrichable = c.req.query("enrichable") === "true";
  const queryText = c.req.query("query");

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
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, orgSlug));
    if (!org) return c.json([]);
    conditions.push(eq(sources.orgId, org.id));
  }

  if (hasFeed || enrichable) {
    conditions.push(
      sql`json_extract(${sources.metadata}, '$.feedUrl') IS NOT NULL AND json_extract(${sources.metadata}, '$.feedUrl') != ''`,
    );
  }

  if (enrichable) {
    conditions.push(
      sql`(json_extract(${sources.metadata}, '$.feedContentDepth') IS NULL OR json_extract(${sources.metadata}, '$.feedContentDepth') = 'summary-only')`,
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

  const rows = conditions.length > 0
    ? await db.select().from(sources).where(and(...conditions)).orderBy(sources.name)
    : await db.select().from(sources).orderBy(sources.name);

  const result = await Promise.all(
    rows.map(async (src) => {
      const [relCount] = await db
        .select({ n: count() })
        .from(releases)
        .where(and(eq(releases.sourceId, src.id), eq(releases.suppressed, false)));

      const [latest] = await db
        .select({ version: releases.version, publishedAt: releases.publishedAt })
        .from(releases)
        .where(and(eq(releases.sourceId, src.id), eq(releases.suppressed, false), sql`${releases.publishedAt} IS NOT NULL`))
        .orderBy(desc(releases.publishedAt))
        .limit(1);

      let orgSlug: string | null = null;
      if (src.orgId) {
        const [org] = await db
          .select({ slug: organizations.slug })
          .from(organizations)
          .where(eq(organizations.id, src.orgId));
        orgSlug = org?.slug ?? null;
      }

      return {
        id: src.id,
        slug: src.slug,
        name: src.name,
        type: src.type,
        url: src.url,
        orgSlug,
        isPrimary: src.isPrimary ?? false,
        metadata: src.metadata ?? null,
        releaseCount: relCount.n,
        latestVersion: latest?.version ?? null,
        latestDate: latest?.publishedAt ?? null,
      };
    }),
  );

  return c.json(result);
});

// ── Fetchable sources (must be before :slug route) ──

sourceRoutes.get("/sources/fetchable", async (c) => {
  const db = createDb(c.env.DB);
  const mode = c.req.query("mode"); // "unfetched" | "stale" | "retry_errors" | "all"
  const staleHours = c.req.query("staleHours");

  let rows: (typeof sources.$inferSelect)[];

  if (mode === "unfetched") {
    rows = await db.select().from(sources).where(sql`${sources.lastFetchedAt} IS NULL`);
  } else if (mode === "stale" && staleHours) {
    const hours = parseInt(staleHours, 10);
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    const now = new Date().toISOString();
    rows = await db.select().from(sources).where(
      and(
        sql`(${sources.lastFetchedAt} IS NULL OR ${sources.lastFetchedAt} < ${cutoff})`,
        sql`(${sources.nextFetchAfter} IS NULL OR ${sources.nextFetchAfter} <= ${now})`,
        sql`${sources.fetchPriority} != 'paused'`
      )
    );
  } else if (mode === "retry_errors") {
    rows = await db.select().from(sources).where(
      sql`${sources.id} IN (
        SELECT f.source_id FROM fetch_log f
        WHERE f.id = (SELECT f2.id FROM fetch_log f2 WHERE f2.source_id = f.source_id ORDER BY f2.created_at DESC LIMIT 1)
        AND f.status = 'error'
      )`
    );
  } else {
    rows = await db.select().from(sources);
  }

  return c.json(rows);
});

// ── Batch release insert for fetch command ──

sourceRoutes.post("/sources/:slug/releases/batch", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
  if (!src) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json<{ releases: Array<{
    version?: string | null; title: string; content: string;
    url?: string | null; contentHash?: string; publishedAt?: string | null;
    media?: string | null;
  }> }>();

  try {
    // Batch insert in chunks — D1 limits query size to ~1MB
    let inserted = 0;
    for (let i = 0; i < body.releases.length; i += 5) {
      const chunk = body.releases.slice(i, i + 5).map((r) => ({
        sourceId: src.id,
        version: r.version ?? null,
        title: r.title,
        content: r.content,
        url: r.url ?? null,
        contentHash: r.contentHash ?? null,
        publishedAt: r.publishedAt ?? null,
        media: r.media ?? "[]",
      }));
      const rows = await db.insert(releases).values(chunk)
        .onConflictDoUpdate({
          target: [releases.sourceId, releases.url],
          set: {
            content: sql`CASE WHEN excluded.content != '' AND releases.content = '' THEN excluded.content ELSE releases.content END`,
            contentHash: sql`CASE WHEN excluded.content != '' AND releases.content = '' THEN excluded.content_hash ELSE releases.content_hash END`,
          },
          where: sql`excluded.content != '' AND releases.content = ''`,
        })
        .returning({ id: releases.id });
      inserted += rows.length;
    }

    const [{ n: total }] = await db.select({ n: count() }).from(releases).where(eq(releases.sourceId, src.id));
    return c.json({ inserted, total });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "insert_failed", message, releaseCount: body.releases.length }, 500);
  }
});

// ── Delete all releases for a source (for --force re-fetch) ──

sourceRoutes.delete("/sources/:slug/releases", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
  if (!src) return c.json({ error: "not_found" }, 404);

  const deleted = await db.delete(releases).where(eq(releases.sourceId, src.id)).returning();
  return c.json({ deleted: deleted.length });
});

sourceRoutes.post("/sources/:slug/content-hash", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ contentHash: string }>();

  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
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

  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
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

// ── Enrichable releases (have URLs, not suppressed) ──

sourceRoutes.get("/sources/:slug/releases", async (c) => {
  const enrichable = c.req.query("enrichable");
  if (enrichable !== "true") return c.json({ error: "enrichable=true query param required" }, 400);

  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;

  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
  if (!src) return c.json({ error: "not_found" }, 404);

  const query = db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.sourceId, src.id),
        isNotNull(releases.url),
        eq(releases.suppressed, false),
      ),
    )
    .orderBy(desc(releases.publishedAt));

  const rows = limit ? await query.limit(limit) : await query;
  return c.json({ releases: rows });
});

// ── Known releases for incremental parsing ──

sourceRoutes.get("/sources/:slug/known-releases", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const limit = parseInt(c.req.query("limit") ?? "10", 10);

  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
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

sourceRoutes.get("/sources/:slug", async (c) => {
  const slug = c.req.param("slug");
  const page = parseInt(c.req.query("page") ?? "1", 10);
  const pageSize = parseInt(c.req.query("pageSize") ?? "20", 10);
  const db = createDb(c.env.DB);

  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
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
  const releaseRows = await db.all<{
    version: string | null;
    title: string;
    content_summary: string | null;
    content: string;
    published_at: string | null;
    url: string | null;
    media: string | null;
  }>(sql`
    SELECT version, title, content_summary, content, published_at, url, media
    FROM releases WHERE source_id = ${src.id} AND (suppressed IS NULL OR suppressed = 0)
    ORDER BY
      CASE WHEN published_at IS NOT NULL THEN 0 ELSE 1 END,
      published_at DESC, fetched_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `);

  const releasesFormatted = releaseRows.map((r) => ({
    version: r.version,
    title: r.title,
    summary:
      r.content_summary ??
      (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
    content: r.content,
    publishedAt: r.published_at,
    url: r.url,
    media: JSON.parse(r.media ?? "[]").map((m: any) => ({
      ...m,
      r2Url: m.r2Key ? `/api/media/${m.r2Key}` : undefined,
    })),
  }));

  const notSuppressed = sql`(${releases.suppressed} IS NULL OR ${releases.suppressed} = 0)`;

  const [latest] = await db
    .select({ version: releases.version, publishedAt: releases.publishedAt })
    .from(releases)
    .where(and(eq(releases.sourceId, src.id), notSuppressed, sql`${releases.publishedAt} IS NOT NULL`))
    .orderBy(desc(releases.publishedAt))
    .limit(1);

  let latestVersion = latest?.version ?? null;
  if (!latestVersion) {
    const [fallback] = await db
      .select({ version: releases.version })
      .from(releases)
      .where(and(eq(releases.sourceId, src.id), notSuppressed))
      .orderBy(desc(releases.fetchedAt))
      .limit(1);
    latestVersion = fallback?.version ?? null;
  }

  // Compute source metrics inline — use fetchedAt as fallback when publishedAt is NULL
  const cutoff = daysAgoIso(30);
  const dateCol = sql`COALESCE(${releases.publishedAt}, ${releases.fetchedAt})`;

  const [recent] = await db
    .select({ n: count() })
    .from(releases)
    .where(and(eq(releases.sourceId, src.id), notSuppressed, sql`${dateCol} >= ${cutoff}`));

  const [totals] = await db
    .select({ total: count(), oldest: min(dateCol) })
    .from(releases)
    .where(and(eq(releases.sourceId, src.id), notSuppressed));

  const releasesLast30Days = recent.n;
  const avgReleasesPerWeek = computeAvgPerWeek(totals.total, totals.oldest);
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

  return c.json({
    id: src.id,
    slug: src.slug,
    name: src.name,
    type: src.type,
    url: src.url,
    orgId: src.orgId,
    org,
    isPrimary: src.isPrimary ?? false,
    metadata: parsedMeta,
    releaseCount: relCount.n,
    releasesLast30Days,
    avgReleasesPerWeek,
    latestVersion,
    latestDate: latest?.publishedAt ?? null,
    changelogUrl: parsedMeta.changelogUrl ?? null,
    lastFetchedAt: src.lastFetchedAt,
    trackingSince: earliest?.date ?? totals.oldest ?? src.createdAt,
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
  });
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
  const type = body.type ?? "scrape";

  // Resolve org by slug if orgSlug provided (preferred over raw orgId)
  let orgId = body.orgId ?? null;
  if (!orgId && body.orgSlug) {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, body.orgSlug));
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
    lastFetchedAt?: string | null; lastContentHash?: string | null;
    fetchPriority?: string; consecutiveNoChange?: number;
    consecutiveErrors?: number; nextFetchAfter?: string | null;
    isPrimary?: boolean;
  }>();

  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.url !== undefined) updates.url = body.url;
  if (body.type !== undefined) updates.type = body.type;
  if (body.metadata !== undefined) updates.metadata = body.metadata;
  if (body.orgId !== undefined) updates.orgId = body.orgId;
  if (body.lastFetchedAt !== undefined) updates.lastFetchedAt = body.lastFetchedAt;
  if (body.lastContentHash !== undefined) updates.lastContentHash = body.lastContentHash;
  if (body.fetchPriority !== undefined) updates.fetchPriority = body.fetchPriority;
  if (body.consecutiveNoChange !== undefined) updates.consecutiveNoChange = body.consecutiveNoChange;
  if (body.consecutiveErrors !== undefined) updates.consecutiveErrors = body.consecutiveErrors;
  if (body.nextFetchAfter !== undefined) updates.nextFetchAfter = body.nextFetchAfter;
  if (body.isPrimary !== undefined) updates.isPrimary = body.isPrimary;

  const [updated] = await db.update(sources).set(updates).where(eq(sources.id, src.id)).returning();
  return c.json(updated);
});

sourceRoutes.delete("/sources/:slug", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  await db.delete(sources).where(eq(sources.id, src.id));
  return c.json({ deleted: true });
});

// Bulk release insert for data seeding
sourceRoutes.post("/sources/:slug/releases", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const body = await c.req.json<{
    id?: string; version?: string; title: string; content: string;
    contentSummary?: string; url?: string; contentHash?: string;
    metadata?: string; publishedAt?: string; fetchedAt?: string;
  }>();

  try {
    const [release] = await db
      .insert(releases)
      .values({
        id: body.id,
        sourceId: src.id,
        version: body.version ?? null,
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
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "insert_failed", message }, 500);
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
    })
    .from(releases)
    .leftJoin(sources, eq(releases.sourceId, sources.id))
    .where(eq(releases.id, id));

  if (rows.length === 0) return c.json({ error: "not_found", message: "Release not found" }, 404);

  const { release, sourceName, sourceSlug } = rows[0];
  return c.json({ ...release, sourceName, sourceSlug });
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
