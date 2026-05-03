import { Hono } from "hono";
import { eq, count, max, min, and, sql, inArray, gte, desc } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  organizations,
  orgAccounts,
  sources,
  sourcesVisible,
  releases,
  releasesVisible,
  products,
  productsActive,
  tags,
  orgTags,
  domainAliases,
  knowledgePages,
} from "@buildinternet/releases-core/schema";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { isValidCategory } from "@buildinternet/releases-core/categories";
import { toSlug } from "@buildinternet/releases-core/slug";
import { isReservedSlug } from "@buildinternet/releases-core/reserved-slugs";
import {
  isConflictError,
  computeAvgPerWeek,
  getOrCreateTagsD1,
  orgWhere,
  heatmapDateRange,
  hydrateMediaUrls,
  parseReleaseMedia,
  parseBoolParam,
  replaceAliases,
} from "../utils.js";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { isValidBearerAuth } from "../middleware/auth.js";
import { orgToMarkdown, orgReleaseFeedToMarkdown } from "@releases/rendering/formatters.js";
import { assemblePlaybook } from "@releases/ai-internal/playbook";
import type { Env } from "../index.js";
import {
  getOrgsWithStats,
  getOrgSparklines,
  getOrgSourcesWithStats,
  getOrgActivityData,
  getOrgHeatmapData,
  getOrgSourceSparklines,
  getOrgReleasesFeed,
} from "../queries/orgs.js";
import { embedAndUpsertEntities, type EntityKind } from "@releases/search/embed-entities.js";
import { buildEmbedConfig } from "../lib/embed-config.js";
import { logEvent } from "@releases/lib/log-event";

export const orgRoutes = new Hono<Env>();

orgRoutes.get("/orgs", async (c) => {
  const db = createDb(c.env.DB);
  const cutoff30d = daysAgoIso(30);
  const qParam = c.req.query("q");

  const [rows, sparklineRows] = await Promise.all([
    getOrgsWithStats(db, cutoff30d, qParam ?? undefined),
    getOrgSparklines(db, cutoff30d),
  ]);

  // Build a 30-day sparkline array per org (align to UTC midnight to avoid off-by-one near day boundary)
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const sparklineMap = new Map<string, number[]>();
  for (const row of sparklineRows) {
    if (!sparklineMap.has(row.org_id)) {
      sparklineMap.set(
        row.org_id,
        Array.from({ length: 30 }, () => 0),
      );
    }
    const dayDate = new Date(row.date + "T00:00:00Z");
    const daysAgo = Math.floor((today.getTime() - dayDate.getTime()) / (1000 * 60 * 60 * 24));
    const idx = 29 - daysAgo;
    if (idx >= 0 && idx < 30) {
      sparklineMap.get(row.org_id)![idx] = row.cnt;
    }
  }

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
    topProducts: row.top_products ? row.top_products.split("||") : [],
    sparkline: sparklineMap.get(row.id) ?? Array.from({ length: 30 }, () => 0),
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
  const cutoff90d = daysAgoIso(90);

  const [
    accounts,
    tagRows,
    orgSources,
    productRows,
    aliasRows,
    totalReleaseRow,
    latestFetchRow,
    latestPollRow,
    knowledgePageRows,
    metricsRow,
  ] = await Promise.all([
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
        id: productsActive.id,
        slug: productsActive.slug,
        name: productsActive.name,
        url: productsActive.url,
        description: productsActive.description,
        sourceCount: sql<number>`(SELECT COUNT(*) FROM sources_active s WHERE s.product_id = products_active.id)`,
      })
      .from(productsActive)
      .where(eq(productsActive.orgId, org.id))
      .orderBy(productsActive.name),

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

    // Latest poll (change-detection check) timestamp across all org sources
    db
      .select({ maxPoll: max(sources.lastPolledAt) })
      .from(sources)
      .where(eq(sources.orgId, org.id)),

    // Overview + playbook pages for this org (single query, split client-side)
    db
      .select()
      .from(knowledgePages)
      .where(
        and(inArray(knowledgePages.scope, ["org", "playbook"]), eq(knowledgePages.orgId, org.id)),
      ),

    // Recent-release metrics — scoped via subquery so this joins the parallel
    // wave instead of blocking on orgSources.
    db
      .select({
        recent: sql<number>`COUNT(CASE WHEN ${releases.publishedAt} >= ${cutoff} THEN 1 END)`,
        recent90d: sql<number>`COUNT(CASE WHEN ${releases.publishedAt} >= ${cutoff90d} THEN 1 END)`,
        oldest: min(releases.publishedAt),
      })
      .from(releases)
      .where(
        and(
          sql`${releases.sourceId} IN (SELECT id FROM sources WHERE org_id = ${org.id})`,
          sql`${releases.publishedAt} IS NOT NULL`,
        ),
      ),
  ]);

  const sourcesWithStats = orgSources.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    url: row.url,
    isPrimary: Boolean(row.is_primary),
    isHidden: Boolean(row.is_hidden),
    discovery: row.discovery ?? "curated",
    fetchPriority: (row.fetch_priority ?? null) as "normal" | "low" | "paused" | null,
    lastFetchedAt: row.last_fetched_at ?? null,
    lastPolledAt: row.last_polled_at ?? null,
    releaseCount: row.release_count,
    latestVersion: row.latest_version_by_date ?? row.latest_version_by_fetch ?? null,
    latestDate: row.latest_date ?? null,
    latestAddedAt: row.latest_added_at ?? null,
    productSlug: row.product_slug ?? null,
    productName: row.product_name ?? null,
  }));

  const metrics = metricsRow[0];
  const releasesLast30Days = metrics.recent;
  const avgReleasesPerWeek = computeAvgPerWeek(metrics.recent90d, metrics.oldest);
  const oldestReleaseDate = metrics.oldest;

  const totalReleases = totalReleaseRow[0];
  const latestFetch = latestFetchRow[0];
  const latestPoll = latestPollRow[0];
  const knowledgeRow = knowledgePageRows.find((r) => r.scope === "org") ?? null;
  // Playbook content (header + agent notes) is internal — only return it to
  // authenticated callers so we don't leak it via the public-cached JSON.
  const isAuthed = await isValidBearerAuth(c);
  const playbookRow = isAuthed
    ? (knowledgePageRows.find((r) => r.scope === "playbook") ?? null)
    : null;

  const overviewData = knowledgeRow
    ? {
        scope: knowledgeRow.scope as "org",
        content: knowledgeRow.content,
        releaseCount: knowledgeRow.releaseCount,
        lastContributingReleaseAt: knowledgeRow.lastContributingReleaseAt,
        generatedAt: knowledgeRow.generatedAt,
        updatedAt: knowledgeRow.updatedAt,
      }
    : null;

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
    lastPolledAt: latestPoll.maxPoll ?? null,
    trackingSince: oldestReleaseDate ?? org.createdAt,
    aliases: aliasRows.map((a) => a.domain),
    accounts,
    products: productRows,
    sources: sourcesWithStats,
    overview: overviewData,
    playbook: playbookRow
      ? {
          scope: playbookRow.scope as "playbook",
          content: assemblePlaybook(playbookRow.content, playbookRow.notes),
          updatedAt: playbookRow.updatedAt,
        }
      : null,
  };

  if (wantsMarkdown(c)) {
    return markdownResponse(c, orgToMarkdown(result as any));
  }

  // Authed responses include the playbook — opt out of the shared CDN cache
  // and signal Vary so any honoring intermediary keys on Authorization.
  if (isAuthed) {
    c.header("Cache-Control", "private, no-store");
  }
  c.header("Vary", "Authorization", { append: true });

  return c.json(result);
});

orgRoutes.post("/orgs", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{
    name: string;
    slug?: string;
    domain?: string;
    description?: string;
    category?: string;
    tags?: string[];
  }>();

  if (!body.name)
    return c.json({ error: "bad_request", message: "Missing required field: name" }, 400);

  if (body.category && !isValidCategory(body.category)) {
    return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
  }

  const slug = body.slug ?? toSlug(body.name);
  if (isReservedSlug(slug, "root")) {
    return c.json(
      {
        error: "slug_reserved",
        message: `Slug "${slug}" is reserved and cannot be used for an organization. Choose a different slug (e.g. by passing an explicit "slug" field) or rename the organization.`,
        slug,
      },
      409,
    );
  }
  const now = new Date().toISOString();

  try {
    const [org] = await db
      .insert(organizations)
      .values({
        name: body.name,
        slug,
        domain: body.domain ?? null,
        description: body.description ?? null,
        category: body.category ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (body.tags && body.tags.length > 0) {
      const tagRows = await getOrCreateTagsD1(db, body.tags);
      const tagCreatedAt = new Date().toISOString();
      await db
        .insert(orgTags)
        .values(tagRows.map((t) => ({ orgId: org.id, tagId: t.id, createdAt: tagCreatedAt })))
        .onConflictDoNothing();
    }

    c.executionCtx.waitUntil(embedOrgSideEffect(c.env, db, org.id));
    return c.json(org, 201);
  } catch (err) {
    if (isConflictError(err)) {
      return c.json(
        { error: "conflict", message: `Organization with slug "${slug}" already exists` },
        409,
      );
    }
    throw err;
  }
});

orgRoutes.patch("/orgs/:slug", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<{
    name?: string;
    slug?: string;
    domain?: string | null;
    description?: string | null;
    category?: string | null;
    tags?: string[];
    aliases?: string[];
  }>();

  if (body.category !== undefined && body.category !== null && !isValidCategory(body.category)) {
    return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
  }

  const [org] = await db.select().from(organizations).where(orgWhere(slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  if (body.slug && isReservedSlug(body.slug, "root")) {
    return c.json(
      {
        error: "slug_reserved",
        message: `Slug "${body.slug}" is reserved and cannot be used for an organization.`,
        slug: body.slug,
      },
      409,
    );
  }

  const updates: Record<string, string | null> = { updatedAt: new Date().toISOString() };
  if (body.name) updates.name = body.name;
  if (body.slug) updates.slug = body.slug;
  if (body.domain !== undefined) updates.domain = body.domain;
  if (body.description !== undefined) updates.description = body.description;
  if (body.category !== undefined) updates.category = body.category;

  const [updated] = await db
    .update(organizations)
    .set(updates)
    .where(eq(organizations.id, org.id))
    .returning();

  if (body.tags !== undefined) {
    await db.delete(orgTags).where(eq(orgTags.orgId, org.id));
    if (body.tags.length > 0) {
      const tagRows = await getOrCreateTagsD1(db, body.tags);
      const now = new Date().toISOString();
      await db
        .insert(orgTags)
        .values(tagRows.map((t) => ({ orgId: org.id, tagId: t.id, createdAt: now })))
        .onConflictDoNothing();
    }
  }

  if (body.aliases !== undefined) {
    const { conflict } = await replaceAliases(db, { orgId: org.id, aliases: body.aliases });
    if (conflict)
      return c.json(
        {
          error: "conflict",
          message: `Domain alias "${conflict}" already claimed by another org or product`,
        },
        409,
      );
  }

  // Re-embed if semantically meaningful fields changed (name/description/
  // category/domain). Tag/slug churn alone doesn't warrant it.
  const semanticChanged =
    body.name !== undefined ||
    body.description !== undefined ||
    body.category !== undefined ||
    body.domain !== undefined;
  if (semanticChanged) {
    c.executionCtx.waitUntil(embedOrgSideEffect(c.env, db, org.id));
  }

  return c.json(updated);
});

orgRoutes.delete("/orgs/:slug", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const hard = c.req.query("hard") === "true";

  // Slug-based lookups always resolve to the active row even with hard=true:
  // tombstones rename the slug ("--<id>" suffix), so a slug match is by
  // construction the active row. To purge a tombstone, callers use the org_
  // ID, which is unique whether the row is active or tombstoned.
  const includeDeleted = hard && slug.startsWith("org_");
  const [org] = await db.select().from(organizations).where(orgWhere(slug, { includeDeleted }));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  if (hard) {
    await db.delete(organizations).where(eq(organizations.id, org.id));
    return c.json({ deleted: true, hard: true });
  }

  // Soft delete: tombstone the org and cascade-tombstone its products and
  // sources. Slug + domain are mangled to "<value>--<id>" so the inline
  // UNIQUE constraints don't block a re-onboard under the original
  // identifier. The cleanup cron hard-purges rows older than 30 days.
  const now = new Date().toISOString();
  await db
    .update(organizations)
    .set({
      deletedAt: now,
      slug: `${org.slug}--${org.id}`,
      domain: org.domain ? `${org.domain}--${org.id}` : null,
    })
    .where(eq(organizations.id, org.id));
  // Cascade-tombstone children. Slug/domain renaming on each child stays
  // consistent: child id is unique so the suffix is unique.
  const orgProducts = await db
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(eq(products.orgId, org.id));
  for (const p of orgProducts) {
    // oxlint-disable-next-line no-await-in-loop -- per-row rename to keep slug suffix tied to row id
    await db
      .update(products)
      .set({ deletedAt: now, slug: `${p.slug}--${p.id}` })
      .where(eq(products.id, p.id));
  }
  const orgSources = await db
    .select({ id: sources.id, slug: sources.slug })
    .from(sources)
    .where(eq(sources.orgId, org.id));
  for (const s of orgSources) {
    // oxlint-disable-next-line no-await-in-loop -- per-row rename to keep slug suffix tied to row id
    await db
      .update(sources)
      .set({ deletedAt: now, slug: `${s.slug}--${s.id}` })
      .where(eq(sources.id, s.id));
  }
  return c.json({ deleted: true, deletedAt: now });
});

// Unified browse for the org's addressable things: sources + products today,
// rollups when #693 ships them. Mirrors what the web's /{orgSlug} page renders
// and what the CLI's catalog-rollup search wants in one round trip.
orgRoutes.get("/orgs/:slug/catalog", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const kindParam = c.req.query("kind");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);

  const [org] = await db.select().from(organizations).where(orgWhere(slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const wantSources = !kindParam || kindParam === "source";
  const wantProducts = !kindParam || kindParam === "product";

  const [productRows, sourceRows] = await Promise.all([
    wantProducts
      ? db
          .select({
            id: productsActive.id,
            slug: productsActive.slug,
            name: productsActive.name,
            url: productsActive.url,
            description: productsActive.description,
            category: productsActive.category,
          })
          .from(productsActive)
          .where(eq(productsActive.orgId, org.id))
          .orderBy(productsActive.name)
          .limit(limit)
      : Promise.resolve([]),
    wantSources
      ? db
          .select({
            id: sourcesVisible.id,
            slug: sourcesVisible.slug,
            name: sourcesVisible.name,
            type: sourcesVisible.type,
            url: sourcesVisible.url,
            productId: sourcesVisible.productId,
          })
          .from(sourcesVisible)
          .where(eq(sourcesVisible.orgId, org.id))
          .orderBy(sourcesVisible.name)
          .limit(limit)
      : Promise.resolve([]),
  ]);

  const items = [
    ...productRows.map((p) => ({ kind: "product" as const, ...p })),
    ...sourceRows.map((s) => ({ kind: "source" as const, ...s })),
  ];

  return c.json({
    org: { id: org.id, slug: org.slug, name: org.name },
    items,
  });
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

  const accounts = await db.select().from(orgAccounts).where(eq(orgAccounts.orgId, org.id));
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

  if (body.tags.length > 0) {
    const tagRows = await getOrCreateTagsD1(db, body.tags);
    const now = new Date().toISOString();
    await db
      .insert(orgTags)
      .values(tagRows.map((t) => ({ orgId: org.id, tagId: t.id, createdAt: now })))
      .onConflictDoNothing();
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
    // oxlint-disable-next-line no-await-in-loop -- sequential: tag lookup result feeds the delete
    const [tag] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
    if (tag) {
      // oxlint-disable-next-line no-await-in-loop -- sequential per-tag delete; ordering matters for partial success
      await db.delete(orgTags).where(and(eq(orgTags.orgId, org.id), eq(orgTags.tagId, tag.id)));
    }
  }
  return c.json({ ok: true });
});

orgRoutes.post("/tags", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ name: string }>();
  if (!body.name)
    return c.json({ error: "bad_request", message: "Missing required field: name" }, 400);

  const tagSlug = toSlug(body.name);
  const [existing] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
  if (existing) return c.json(existing);

  const [created] = await db
    .insert(tags)
    .values({ name: body.name, slug: tagSlug, createdAt: new Date().toISOString() })
    .returning();
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
    return c.json(
      { error: "bad_request", message: "Invalid date format for 'from'. Use YYYY-MM-DD." },
      400,
    );
  }
  if (toParam && !dateRe.test(toParam)) {
    return c.json(
      { error: "bad_request", message: "Invalid date format for 'to'. Use YYYY-MM-DD." },
      400,
    );
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
      .select({
        oldest: min(releasesVisible.publishedAt),
        newest: max(releasesVisible.publishedAt),
      })
      .from(releasesVisible)
      .where(
        and(
          inArray(releasesVisible.sourceId, sourceIds),
          sql`${releasesVisible.publishedAt} IS NOT NULL`,
        ),
      );
    const today = new Date().toISOString().slice(0, 10);
    if (!from) from = bounds.oldest?.slice(0, 10) ?? today;
    if (!to) to = bounds.newest?.slice(0, 10) ?? today;
  }

  // Compute exclusive upper bound for inclusive to-date
  const toDate = new Date(to + "T00:00:00Z");
  toDate.setUTCDate(toDate.getUTCDate() + 1);
  const toExclusive = toDate.toISOString().slice(0, 10);

  const {
    bucketRows,
    statsRows,
    latestVersionRows: versionRows,
    earliestVersionRows,
  } = await getOrgActivityData(db, org.id, sourceIds, from, toExclusive);

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
  const bucketMap = new Map<
    string,
    {
      weekStart: string;
      count: number;
      earliestVersion: string | null;
      latestVersion: string | null;
    }[]
  >();
  for (const row of bucketRows) {
    let arr = bucketMap.get(row.source_id);
    if (!arr) {
      arr = [];
      bucketMap.set(row.source_id, arr);
    }
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
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, releaseCount]) => ({ weekStart, count: releaseCount }));

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

  const { from, to, toExclusive } = heatmapDateRange();
  const { rows, total } = await getOrgHeatmapData(db, org.id, from, toExclusive);

  return c.json({
    org: { slug: org.slug, name: org.name },
    range: { from, to },
    dailyCounts: rows.map((r) => ({ date: r.date, count: r.cnt })),
    total,
  });
});

// Per-source and per-product sparklines (30-day daily release counts)
orgRoutes.get("/orgs/:slug/sparklines", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

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

  const cutoff30d = daysAgoIso(30);
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const fromDate = new Date(today);
  fromDate.setUTCDate(fromDate.getUTCDate() - 29);
  const from = fromDate.toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);

  const [sparklineRows, orgSources, productRows] = await Promise.all([
    getOrgSourceSparklines(db, org.id, cutoff30d),
    db
      .select({
        id: sources.id,
        slug: sources.slug,
        name: sources.name,
        productId: sources.productId,
      })
      .from(sources)
      .where(eq(sources.orgId, org.id))
      .orderBy(sources.name),
    db
      .select({ id: products.id, slug: products.slug, name: products.name })
      .from(products)
      .where(eq(products.orgId, org.id))
      .orderBy(products.name),
  ]);

  // Build per-source sparkline arrays (30 entries, index 0 = 30d ago)
  const sourceSparklineMap = new Map<string, number[]>();
  for (const src of orgSources) {
    sourceSparklineMap.set(
      src.id,
      Array.from({ length: 30 }, () => 0),
    );
  }
  for (const row of sparklineRows) {
    let arr = sourceSparklineMap.get(row.source_id);
    if (!arr) {
      arr = Array.from({ length: 30 }, () => 0);
      sourceSparklineMap.set(row.source_id, arr);
    }
    const dayDate = new Date(row.date + "T00:00:00Z");
    const daysAgo = Math.floor((today.getTime() - dayDate.getTime()) / (1000 * 60 * 60 * 24));
    const idx = 29 - daysAgo;
    if (idx >= 0 && idx < 30) {
      arr[idx] = row.cnt;
    }
  }

  // Assemble per-source output
  const sourcesOut = orgSources.map((src) => ({
    slug: src.slug,
    name: src.name,
    sparkline: sourceSparklineMap.get(src.id) ?? Array.from({ length: 30 }, () => 0),
  }));

  // Aggregate per-product by summing source sparklines
  const productSourceMap = new Map<string, string[]>();
  for (const src of orgSources) {
    if (src.productId) {
      let arr = productSourceMap.get(src.productId);
      if (!arr) {
        arr = [];
        productSourceMap.set(src.productId, arr);
      }
      arr.push(src.id);
    }
  }

  const productsOut = productRows.map((prod) => {
    const sourceIds = productSourceMap.get(prod.id) ?? [];
    const sparkline = Array.from({ length: 30 }, () => 0);
    for (const srcId of sourceIds) {
      const srcSparkline = sourceSparklineMap.get(srcId);
      if (srcSparkline) {
        for (let i = 0; i < 30; i++) sparkline[i] += srcSparkline[i];
      }
    }
    return { slug: prod.slug, name: prod.name, sparkline };
  });

  // Aggregate total across all sources
  const aggregate = Array.from({ length: 30 }, () => 0);
  for (const src of orgSources) {
    const srcSparkline = sourceSparklineMap.get(src.id);
    if (srcSparkline) {
      for (let i = 0; i < 30; i++) aggregate[i] += srcSparkline[i];
    }
  }

  return c.json({
    org: { slug: org.slug, name: org.name },
    range: { from, to },
    aggregate,
    sources: sourcesOut,
    products: productsOut,
  });
});

// Combined release feed for an org
orgRoutes.get("/orgs/:slug/releases", async (c) => {
  const slug = c.req.param("slug");
  const cursorParam = c.req.query("cursor") ?? null;
  const parsedLimit = parseInt(c.req.query("limit") ?? "20", 10);
  const limit = isNaN(parsedLimit) || parsedLimit < 1 ? 20 : Math.min(parsedLimit, 100);
  const includeCoverage = parseBoolParam(c.req.query("include_coverage"));

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
    const cursorDate =
      pipeIdx > 0 ? cursorParam.slice(0, pipeIdx) : pipeIdx === -1 ? cursorParam : "";
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

  const results = await getOrgReleasesFeed(
    c.env.DB,
    org.id,
    { cursorWhere, cursorBindings },
    limit + 1,
    { includeCoverage },
  );

  const hasMore = results.length > limit;
  const pageRows = hasMore ? results.slice(0, limit) : results;

  // Build next cursor from last item
  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = last.published_at ? `${last.published_at}|${last.id}` : `|${last.id}`;
  }

  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
  const releasesFormatted = pageRows.map((r) => ({
    id: r.id,
    version: r.version,
    type: r.type,
    title: r.title,
    summary:
      r.content_summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
    content: hydrateMediaUrls(r.content, mediaOrigin),
    publishedAt: r.published_at,
    url: r.url,
    media: parseReleaseMedia(r.media, mediaOrigin),
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

// ---------------------------------------------------------------------------
// GET /orgs/:slug/recent-releases?since=<iso>&limit=<n>
//
// Returns releases for grouping / summarization — same shape as the local
// getRecentReleasesByOrg query (full Release row + sourceName/sourceSlug),
// filtered to `publishedAt >= since` and skipping suppressed + disabled.
// ---------------------------------------------------------------------------

orgRoutes.get("/orgs/:slug/recent-releases", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const since = c.req.query("since");
  const limitParam = parseInt(c.req.query("limit") ?? "500", 10);
  const limit = isNaN(limitParam) || limitParam < 1 ? 500 : Math.min(limitParam, 2000);

  if (!since) {
    return c.json(
      { error: "bad_request", message: "Missing required query param: since (ISO date)" },
      400,
    );
  }

  const [org] = await db.select({ id: organizations.id }).from(organizations).where(orgWhere(slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const rows = await db
    .select({
      id: releasesVisible.id,
      sourceId: releasesVisible.sourceId,
      version: releasesVisible.version,
      type: releasesVisible.type,
      title: releasesVisible.title,
      content: releasesVisible.content,
      contentSummary: releasesVisible.contentSummary,
      url: releasesVisible.url,
      contentHash: releasesVisible.contentHash,
      metadata: releasesVisible.metadata,
      media: releasesVisible.media,
      publishedAt: releasesVisible.publishedAt,
      suppressed: releasesVisible.suppressed,
      suppressedReason: releasesVisible.suppressedReason,
      fetchedAt: releasesVisible.fetchedAt,
      embeddedAt: releasesVisible.embeddedAt,
      sourceName: sourcesVisible.name,
      sourceSlug: sourcesVisible.slug,
    })
    .from(releasesVisible)
    .innerJoin(sourcesVisible, eq(releasesVisible.sourceId, sourcesVisible.id))
    .where(and(eq(sourcesVisible.orgId, org.id), gte(releasesVisible.publishedAt, since)))
    .orderBy(desc(releasesVisible.publishedAt))
    .limit(limit);

  return c.json(rows);
});

orgRoutes.post("/orgs/:slug/accounts", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ platform: string; handle: string }>();

  if (!body.platform || !body.handle) {
    return c.json(
      { error: "bad_request", message: "Missing required fields: platform, handle" },
      400,
    );
  }

  const [org] = await db.select().from(organizations).where(orgWhere(slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  try {
    const [account] = await db
      .insert(orgAccounts)
      .values({
        orgId: org.id,
        platform: body.platform,
        handle: body.handle,
        createdAt: new Date().toISOString(),
      })
      .returning();
    return c.json(account, 201);
  } catch (err) {
    if (isConflictError(err)) {
      return c.json(
        { error: "conflict", message: `Account ${body.platform}/${body.handle} already exists` },
        409,
      );
    }
    throw err;
  }
});

// ── Embed side effect ──

async function embedOrgSideEffect(
  env: Env["Bindings"],
  db: ReturnType<typeof createDb>,
  orgId: string,
): Promise<void> {
  try {
    const embedConfig = await buildEmbedConfig(env);
    if (!embedConfig) return;
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org) return;
    await embedAndUpsertEntities({
      entities: [
        {
          id: org.id,
          kind: "org" as EntityKind,
          name: org.name,
          description: org.description,
          category: org.category,
          domain: org.domain,
          // Set `orgId` to the org's own id so the metadata filter works
          // uniformly — an "org scope" lookup can match orgs, products, and
          // sources all via `filter: { org_id: <id> }`.
          orgId: org.id,
        },
      ],
      // Cast: workers-types VectorizeIndex has a stricter metadata value
      // type than the shared runtime-agnostic interface. Assignable at
      // runtime; only diverges by type-system variance.
      vectorIndex:
        env.ENTITIES_INDEX as unknown as import("@releases/search/vector-search.js").VectorizeIndex,
      embedConfig,
      onPersisted: async () => {
        await db
          .update(organizations)
          .set({ embeddedAt: new Date().toISOString() })
          .where(eq(organizations.id, org.id));
      },
    });
  } catch (err) {
    logEvent("warn", {
      component: "orgs",
      event: "embed-side-effect-failed",
      err: err instanceof Error ? err : String(err),
    });
  }
}
