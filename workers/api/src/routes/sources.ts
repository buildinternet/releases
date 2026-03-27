import { Hono } from "hono";
import { eq, desc, count, and, min, gte, isNull, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { sources, releases, organizations } from "../../../../src/db/schema.js";
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
        .where(eq(releases.sourceId, src.id));

      const [latest] = await db
        .select({ version: releases.version, publishedAt: releases.publishedAt })
        .from(releases)
        .where(and(eq(releases.sourceId, src.id), sql`${releases.publishedAt} IS NOT NULL`))
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
    .where(eq(releases.sourceId, src.id));

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
    FROM releases WHERE source_id = ${src.id}
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
    publishedAt: r.published_at,
    url: r.url,
  }));

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

  // Compute source metrics inline
  const cutoff = daysAgoIso(30);

  const [recent] = await db
    .select({ n: count() })
    .from(releases)
    .where(and(eq(releases.sourceId, src.id), gte(releases.publishedAt, cutoff)));

  const [totals] = await db
    .select({ total: count(), oldest: min(releases.publishedAt) })
    .from(releases)
    .where(and(eq(releases.sourceId, src.id), sql`${releases.publishedAt} IS NOT NULL`));

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
  const body = await c.req.json<{ name?: string; url?: string; metadata?: string; orgId?: string | null }>();

  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.url !== undefined) updates.url = body.url;
  if (body.metadata !== undefined) updates.metadata = body.metadata;
  if (body.orgId !== undefined) updates.orgId = body.orgId;

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
