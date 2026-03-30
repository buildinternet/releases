import { Hono } from "hono";
import { eq, desc, count, and, min, isNull, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { sources, releases, organizations, fetchLog } from "../../../../src/db/schema.js";
import { daysAgoIso } from "../../../../src/lib/dates.js";
import { toSlug } from "../../../../src/lib/slug.js";
import { isConflictError, computeAvgPerWeek } from "../utils.js";
import type { Env } from "../index.js";

export const sourceRoutes = new Hono<Env>();

sourceRoutes.get("/sources", async (c) => {
  const db = createDb(c.env.DB);
  const independent = c.req.query("independent") === "true";

  const rows = await (independent
    ? db.select().from(sources).where(isNull(sources.orgId)).orderBy(sources.name)
    : db.select().from(sources).orderBy(sources.name));

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
      }));
      const rows = await db.insert(releases).values(chunk).onConflictDoNothing().returning({ id: releases.id });
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
  }>(sql`
    SELECT version, title, content_summary, content, published_at, url
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

  return c.json({
    id: src.id,
    slug: src.slug,
    name: src.name,
    type: src.type,
    url: src.url,
    org,
    releaseCount: relCount.n,
    releasesLast30Days,
    avgReleasesPerWeek,
    latestVersion,
    latestDate: latest?.publishedAt ?? null,
    changelogUrl: (() => { try { const m = JSON.parse(src.metadata || "{}"); return m.changelogUrl ?? null; } catch { return null; } })(),
    lastFetchedAt: src.lastFetchedAt,
    trackingSince: src.createdAt,
    releases: releasesFormatted,
    pagination: { page, pageSize, totalPages, totalItems: relCount.n },
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
    name?: string; url?: string; metadata?: string; orgId?: string | null;
    lastFetchedAt?: string | null; lastContentHash?: string | null;
    fetchPriority?: string; consecutiveNoChange?: number;
    consecutiveErrors?: number; nextFetchAfter?: string | null;
  }>();

  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.url !== undefined) updates.url = body.url;
  if (body.metadata !== undefined) updates.metadata = body.metadata;
  if (body.orgId !== undefined) updates.orgId = body.orgId;
  if (body.lastFetchedAt !== undefined) updates.lastFetchedAt = body.lastFetchedAt;
  if (body.lastContentHash !== undefined) updates.lastContentHash = body.lastContentHash;
  if (body.fetchPriority !== undefined) updates.fetchPriority = body.fetchPriority;
  if (body.consecutiveNoChange !== undefined) updates.consecutiveNoChange = body.consecutiveNoChange;
  if (body.consecutiveErrors !== undefined) updates.consecutiveErrors = body.consecutiveErrors;
  if (body.nextFetchAfter !== undefined) updates.nextFetchAfter = body.nextFetchAfter;

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
