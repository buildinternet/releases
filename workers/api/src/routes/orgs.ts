import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { hideInProduction } from "../openapi.js";
import {
  OrgListResponseSchema,
  OrgDetailSchema,
  CreateOrgBodySchema,
  UpdateOrgBodySchema,
  SetOrgAvatarBodySchema,
  SetOrgAvatarResponseSchema,
  ErrorResponseSchema,
  OrgAccountsResponseSchema,
  OrgAccountItemSchema,
  AddOrgAccountBodySchema,
  OrgTagsResponseSchema,
  OrgTagsBodySchema,
  OrgTagsMutationResponseSchema,
  OrgCatalogResponseSchema,
  OrgCollectionsResponseSchema,
  OrgActivityResponseSchema,
  OrgHeatmapResponseSchema,
  OrgSparklinesResponseSchema,
  OrgReleasesFeedResponseSchema,
  OrgRecentReleasesResponseSchema,
  CreateTagBodySchema,
  TagRowSchema,
  DeleteOrgAccountResponseSchema,
  SyncWellKnownResponseSchema,
} from "@buildinternet/releases-api-types";
import { validateJson } from "../lib/validate.js";
import { ingestOrgAvatar } from "../lib/avatar-ingest.js";
import { syncOrgWellKnown } from "../lib/well-known/reconcile-org.js";
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
  knowledgePageCitations,
} from "@buildinternet/releases-core/schema";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { parseCompositionFromMetadata } from "@buildinternet/releases-core/composition";
import { parseNotice, setNoticeInMetadata, type Notice } from "@buildinternet/releases-core/notice";
import { parseKindParam, KIND_VALUES, isValidKind } from "@buildinternet/releases-core/kinds";
import { resolveCategoryInput } from "@releases/core-internal/category-alias";
import { parseSourceTypesLenient } from "../lib/source-types.js";
import { toSlug } from "@buildinternet/releases-core/slug";
import { isReservedSlug } from "@buildinternet/releases-core/reserved-slugs";
import { toFtsPrefixMatchQuery } from "@buildinternet/releases-core/fts";
import {
  isConflictError,
  computeAvgPerWeek,
  getOrCreateTagsD1,
  orgWhere,
  heatmapDateRange,
  hydrateMediaUrls,
  parseReleaseMedia,
  buildFeedCursor,
  parseBoolParam,
  parseFeedCursor,
  parseLimitParam,
  parseTimeWindow,
  replaceAliases,
  findProductForOrgSlug,
} from "../utils.js";
import { IN_ARRAY_CHUNK_SIZE } from "../lib/d1-limits.js";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { isValidBearerAuth } from "../middleware/auth.js";
import { orgToMarkdown, orgReleaseFeedToMarkdown } from "@releases/rendering/formatters.js";
import { assemblePlaybook } from "@releases/ai-internal/playbook";
import { appStoreSourceInfo } from "@releases/adapters/appstore";
import { videoSourceInfo } from "@releases/adapters/source-meta";
import type { Env } from "../index.js";
import {
  getOrgsWithStats,
  countOrgsForList,
  getOrgSparklines,
  getOrgSourcesWithStats,
  getOrgActivityData,
  getOrgHeatmapData,
  getOrgSourceSparklines,
  getOrgReleasesFeed,
} from "../queries/orgs.js";
import { listCollectionsWhere } from "../queries/collections.js";
import { embedAndUpsertEntities, type EntityKind } from "@releases/search/embed-entities.js";
import { buildEmbedConfig } from "@releases/search/embed-config.js";
import { logEvent } from "@releases/lib/log-event";
import { dbErrorLogFields } from "@releases/lib/db-errors";
import { buildListResponse, parseListPagination } from "../lib/pagination.js";
import { invalidateLatestCache } from "../lib/latest-cache.js";

export const orgRoutes = new Hono<Env>();

orgRoutes.get(
  "/orgs",
  describeRoute({
    tags: ["Orgs"],
    summary: "List organizations",
    description:
      "Paginated list of orgs with 30-day release sparklines. Supports `?q=` substring search on name/slug. Orgs that have no indexed releases yet are hidden by default; pass `?includeEmpty=true` to opt in. The response always carries `meta.emptyOrgCount` so a UI toggle can show how many are hidden without a second round-trip.",
    parameters: [
      {
        name: "q",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "Case-insensitive substring match on name or slug.",
      },
      {
        name: "category",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Filter to a single canonical category slug (e.g. `ai`, `devops`). Invalid values are ignored (unfiltered). `meta.emptyOrgCount` is scoped to the same filter.",
      },
      {
        name: "page",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1 },
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1 },
      },
      {
        name: "includeEmpty",
        in: "query",
        required: false,
        schema: { type: "boolean" },
        description:
          "Include orgs that have zero indexed releases. Default `false` — empty orgs are stubs from in-flight discovery or broken parsers and surface as noise on the public catalog.",
      },
      {
        name: "featured",
        in: "query",
        required: false,
        schema: { type: "boolean" },
        description:
          "Filter to editorially featured orgs only (home-page rail). Default unfiltered.",
      },
    ],
    responses: {
      200: {
        description: "Paginated org list",
        content: { "application/json": { schema: resolver(OrgListResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const cutoff30d = daysAgoIso(30);
    const qParam = c.req.query("q");
    const pagination = parseListPagination(new URL(c.req.url).searchParams);
    // Default off — orgs without indexed releases are stubs; admin surfaces
    // see them through `/v1/admin/*`, not this public catalog route.
    const includeEmpty = parseBoolParam(c.req.query("includeEmpty"));
    // Optional category filter. Aliases (e.g. "e-commerce" → "commerce") are
    // resolved to their canonical slug; unknown values fail-open to unfiltered.
    const categoryParam = c.req.query("category");
    const categoryResolved = categoryParam
      ? await resolveCategoryInput(db, categoryParam)
      : undefined;
    const category = categoryResolved?.ok ? categoryResolved.slug : undefined;
    // Optional featured filter — narrows to editorially promoted orgs for the home page.
    const featured = parseBoolParam(c.req.query("featured"));

    const [rows, counts] = await Promise.all([
      getOrgsWithStats(
        db,
        cutoff30d,
        qParam ?? undefined,
        {
          limit: pagination.pageSize,
          offset: pagination.offset,
        },
        { includeEmpty, category, featured },
      ),
      countOrgsForList(db, qParam ?? undefined, { includeEmpty, category, featured }),
    ]);
    const sparklineRows = await getOrgSparklines(
      db,
      cutoff30d,
      rows.map((row) => row.id),
    );

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
      avatarUrl: row.avatar_url,
      featured: Boolean(row.featured),
      sourceCount: row.source_count,
      releaseCount: row.release_count,
      recentReleaseCount: row.recent_release_count,
      lastActivity: row.last_activity ?? null,
      topProducts: row.top_products ? row.top_products.split("||") : [],
      sparkline: sparklineMap.get(row.id) ?? Array.from({ length: 30 }, () => 0),
    }));

    return c.json({
      ...buildListResponse(result, pagination, counts.totalItems),
      meta: { emptyOrgCount: counts.emptyOrgCount },
    });
  },
);

orgRoutes.get(
  "/orgs/:slug",
  describeRoute({
    tags: ["Orgs"],
    summary: "Get organization detail",
    description:
      "Resolves by slug, `org_…` ID, or domain alias. Authenticated callers also receive the org playbook (private; CDN cache opt-out).",
    responses: {
      200: {
        description: "Organization detail",
        content: {
          "application/json": { schema: resolver(OrgDetailSchema) },
          "text/markdown": { schema: { type: "string" } },
        },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
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
      citationRows,
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
          kind: productsActive.kind,
          sourceCount: sql<number>`(SELECT COUNT(*) FROM sources_active s WHERE s.product_id = products_active.id)`,
          releaseCount: sql<number>`(SELECT COUNT(*) FROM releases_visible rv JOIN sources_active sa ON sa.id = rv.source_id WHERE sa.product_id = products_active.id)`,
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

      // Citations attached to the org-scope overview page. Joined here so the
      // bare /v1/orgs/:slug response carries them — same shape the dedicated
      // /v1/orgs/:slug/overview endpoint returns.
      db
        .select({
          startIndex: knowledgePageCitations.startIndex,
          endIndex: knowledgePageCitations.endIndex,
          sourceUrl: knowledgePageCitations.sourceUrl,
          title: knowledgePageCitations.title,
          citedText: knowledgePageCitations.citedText,
          releaseId: knowledgePageCitations.releaseId,
        })
        .from(knowledgePageCitations)
        .innerJoin(knowledgePages, eq(knowledgePageCitations.knowledgePageId, knowledgePages.id))
        .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, org.id)))
        .orderBy(knowledgePageCitations.startIndex),

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
      kind: row.kind && isValidKind(row.kind) ? row.kind : null,
      metadata: row.metadata ?? null,
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
          citations: citationRows,
        }
      : null;

    const result = {
      id: org.id,
      slug: org.slug,
      name: org.name,
      domain: org.domain,
      description: org.description,
      category: org.category,
      avatarUrl: org.avatarUrl,
      isHidden: org.isHidden,
      autoGenerateContent: org.autoGenerateContent,
      featured: org.featured,
      fetchPaused: org.fetchPaused,
      discovery: org.discovery,
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
      notice: parseNotice(org.metadata),
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
  },
);

orgRoutes.post(
  "/orgs",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Create organization",
    description:
      "Slug derived from `name` when omitted. `category` is resolved through the alias overlay (e.g. `e-commerce` → `commerce`) before persisting.",
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: "Organization created" },
      400: {
        description: "Invalid request body or category",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      409: {
        description: "Slug conflict or reserved slug",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(CreateOrgBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const body: {
      name: string;
      slug?: string;
      domain?: string;
      description?: string;
      category?: string;
      tags?: string[];
    } = { ...c.req.valid("json") };

    // Resolve through the alias overlay so "e-commerce" → "commerce" before
    // it lands in `organizations.category`. Canonical slugs pass through.
    if (body.category) {
      const resolved = await resolveCategoryInput(db, body.category);
      if (!resolved.ok) {
        return c.json(
          { error: "bad_request", message: `Invalid category: "${body.category}"` },
          400,
        );
      }
      body.category = resolved.slug;
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
  },
);

orgRoutes.post(
  "/orgs/:slug/avatar",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Set organization avatar from a remote image",
    description:
      "Fetches `sourceUrl`, validates it is a reasonable square raster (png/jpeg/gif/webp, ≥128px per side, roughly square), mirrors it to R2 at `orgs/{slug}.{ext}` (served from media.releases.sh), and sets the org's `avatarUrl`. Idempotent — a re-run overwrites the same key. Keeps CF credentials server-side; the CLI passes only a resolved image URL.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Avatar stored and avatarUrl set",
        content: { "application/json": { schema: resolver(SetOrgAvatarResponseSchema) } },
      },
      400: {
        description: "Invalid sourceUrl",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      422: {
        description: "Image is not a usable square raster",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(SetOrgAvatarBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const { sourceUrl } = c.req.valid("json") as { sourceUrl: string };

    const [org] = await db.select().from(organizations).where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    const result = await ingestOrgAvatar({
      sourceUrl,
      slug: org.slug,
      bucket: c.env.MEDIA,
      mediaOrigin: c.env.MEDIA_ORIGIN ?? "https://media.releases.sh",
    });
    if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status);

    await db
      .update(organizations)
      .set({ avatarUrl: result.avatarUrl, updatedAt: new Date().toISOString() })
      .where(eq(organizations.id, org.id));

    return c.json({
      avatarUrl: result.avatarUrl,
      key: result.key,
      width: result.width,
      height: result.height,
    });
  },
);

orgRoutes.post(
  "/orgs/:slug/sync-well-known",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Reconcile org metadata from the owner's .well-known/releases.json",
    description:
      "Fetches https://{org.domain}/.well-known/releases.json, validates it, and reconciles owner-declared identity fields onto the org (never clobbering curator/editorial fields). Pass ?dryRun=1 (or ?dryRun=true) to preview the computed diff without applying. Requires write scope.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Sync result (applied, or the dry-run plan)",
        content: { "application/json": { schema: resolver(SyncWellKnownResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const dryRun = c.req.query("dryRun") === "1" || c.req.query("dryRun") === "true";

    const [org] = await db.select().from(organizations).where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    const result = await syncOrgWellKnown(db, org.id, {
      bucket: c.env.MEDIA,
      mediaOrigin: c.env.MEDIA_ORIGIN ?? "https://media.releases.sh",
      domain: org.domain,
      dryRun,
    });
    return c.json(result);
  },
);

orgRoutes.patch(
  "/orgs/:slug",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Update organization",
    description:
      "All body fields optional. `domain`, `description`, `category`, `avatarUrl` accept `null` to clear. `tags` and `aliases` arrays replace the full set when provided.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: "Organization updated" },
      400: {
        description: "Invalid category",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      409: {
        description: "Reserved slug or alias conflict",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(UpdateOrgBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const body: {
      name?: string;
      slug?: string;
      domain?: string | null;
      description?: string | null;
      category?: string | null;
      avatarUrl?: string | null;
      tags?: string[];
      aliases?: string[];
      fetchPaused?: boolean;
      isHidden?: boolean;
      autoGenerateContent?: boolean;
      featured?: boolean;
      discovery?: "curated" | "agent" | "on_demand";
      notice?: Notice | null;
    } = { ...c.req.valid("json") };

    if (body.category !== undefined && body.category !== null) {
      const resolved = await resolveCategoryInput(db, body.category);
      if (!resolved.ok) {
        return c.json(
          { error: "bad_request", message: `Invalid category: "${body.category}"` },
          400,
        );
      }
      body.category = resolved.slug;
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

    // Run alias replacement first so a conflict short-circuits before any
    // org/tag writes commit. D1 has no interactive transactions, so this
    // ordering — not a true rollback — is the closest we get to atomicity.
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

    const updates: Record<string, string | boolean | null> = {
      updatedAt: new Date().toISOString(),
    };
    if (body.name) updates.name = body.name;
    if (body.slug) updates.slug = body.slug;
    if (body.domain !== undefined) updates.domain = body.domain;
    if (body.description !== undefined) updates.description = body.description;
    if (body.category !== undefined) updates.category = body.category;
    if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;
    if (body.fetchPaused !== undefined) updates.fetchPaused = body.fetchPaused;
    if (body.isHidden !== undefined) updates.isHidden = body.isHidden;
    if (body.autoGenerateContent !== undefined)
      updates.autoGenerateContent = body.autoGenerateContent;
    if (body.featured !== undefined) updates.featured = body.featured;
    if (body.discovery !== undefined) updates.discovery = body.discovery;
    if (body.notice !== undefined)
      updates.metadata = setNoticeInMetadata(org.metadata, body.notice);

    const [updated] = await db
      .update(organizations)
      .set(updates)
      .where(eq(organizations.id, org.id))
      .returning();

    // Only purge when visibility actually flips — a no-op toggle shouldn't
    // force a homepage-ticker recompute. Hiding/unhiding changes what the
    // ticker + /v1/releases/latest default shapes return; purge so the change
    // appears within seconds rather than waiting out the 300s KV TTL.
    // Best-effort, gated on INVALIDATION_ENABLED. `sourceId` is only an
    // invalidation log tag (the purge clears the fixed default + ticker shapes
    // regardless of scope); we pass the org id since this isn't source-scoped.
    if (body.isHidden !== undefined && body.isHidden !== org.isHidden) {
      c.executionCtx.waitUntil(invalidateLatestCache(c.env, { nReleases: 1, cause: org.id }));
    }

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
  },
);

orgRoutes.delete(
  "/orgs/:slug",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Delete organization",
    description:
      "Soft delete by default (tombstones the org and cascades to its products and sources; rows reclaimed by the nightly tombstone sweep). Pass `?hard=true` with an `org_…` ID to purge immediately.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "hard",
        in: "query",
        required: false,
        schema: { type: "boolean" },
        description:
          "Hard-delete instead of soft-tombstoning. Only honored when the path identifier is an `org_…` ID.",
      },
    ],
    responses: {
      200: { description: "Tombstoned or hard-deleted" },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const hard = c.req.query("hard") === "true";
    const isOrgId = slug.startsWith("org_");

    // Hard delete requires the immutable org_ ID. Slugs are mutable and
    // collision-prone (post-rename, post-tombstone), so accepting them on a
    // destructive path is too easy to misfire. ID-only matches the OpenAPI
    // contract and the original tombstone-purge use case.
    if (hard && !isOrgId) {
      return c.json(
        {
          error: "bad_request",
          message:
            "Hard delete requires an org_ ID; slug is not accepted on this destructive path.",
        },
        400,
      );
    }

    const includeDeleted = hard && isOrgId;
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
    // Cascade-tombstone children. The slug-rename suffix uses each row's
    // own id (`slug || '--' || id`), so the whole cascade for a child table
    // collapses to a single bulk UPDATE — one statement per child table,
    // regardless of how many rows the org has.
    await db
      .update(products)
      .set({ deletedAt: now, slug: sql`${products.slug} || '--' || ${products.id}` })
      .where(eq(products.orgId, org.id));
    await db
      .update(sources)
      .set({ deletedAt: now, slug: sql`${sources.slug} || '--' || ${sources.id}` })
      .where(eq(sources.orgId, org.id));
    return c.json({ deleted: true, deletedAt: now });
  },
);

// Unified browse for the org's addressable things: sources + products today,
// rollups when #693 ships them. `?entryType=source|product` narrows the response
// by entry type; `?kind=<entity-kind>` narrows by entity kind (platform/sdk/…);
// `?limit=N` is per-entryType (capped [1, 500]); invalid values return 400.
const CATALOG_ENTRY_TYPES = new Set(["source", "product"]);
orgRoutes.get(
  "/orgs/:slug/catalog",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Org catalog (sources + products)",
    description:
      "Returns the org's sources and products as a unified list keyed by `entryType`. Accepts optional `?entryType=source|product` to filter to one entry type; `?kind=<entity-kind>` to filter by entity kind (platform/sdk/mobile/…); `?limit=N` caps results per entryType (capped [1, 500]). Intended for org-detail UI sidebar — avoids a round-trip to `/v1/sources` + `/v1/products`.",
    parameters: [
      {
        name: "entryType",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["source", "product"] },
        description: "Narrow results to one entry type. Omit to return both.",
      },
      {
        name: "kind",
        in: "query",
        required: false,
        schema: { type: "string", enum: KIND_VALUES as unknown as string[] },
        description: `Filter by entity kind. Direct match on the row's own kind — no inheritance from a parent. One of: ${KIND_VALUES.join(", ")}.`,
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        description: "Max results per entry type. Defaults to 100.",
      },
    ],
    responses: {
      200: {
        description: "Org catalog",
        content: { "application/json": { schema: resolver(OrgCatalogResponseSchema) } },
      },
      400: {
        description: "Unknown entryType or kind value",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const entryTypeParam = c.req.query("entryType");
    if (entryTypeParam !== undefined && !CATALOG_ENTRY_TYPES.has(entryTypeParam)) {
      return c.json(
        {
          error: "bad_request",
          message: `Unknown entryType '${entryTypeParam}'. Expected source or product.`,
        },
        400,
      );
    }
    const entityKind = parseKindParam(c.req.query("kind"));
    if (entityKind === null)
      return c.json(
        {
          error: "bad_request",
          message: `Invalid kind. Expected one of: ${KIND_VALUES.join(", ")}`,
        },
        400,
      );
    const limitRaw = parseInt(c.req.query("limit") ?? "100", 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);

    const [org] = await db.select().from(organizations).where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    const wantSources = !entryTypeParam || entryTypeParam === "source";
    const wantProducts = !entryTypeParam || entryTypeParam === "product";

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
              kind: productsActive.kind,
            })
            .from(productsActive)
            .where(
              and(
                eq(productsActive.orgId, org.id),
                ...(entityKind ? [eq(productsActive.kind, entityKind)] : []),
              ),
            )
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
              kind: sourcesVisible.kind,
            })
            .from(sourcesVisible)
            .where(
              and(
                eq(sourcesVisible.orgId, org.id),
                ...(entityKind ? [eq(sourcesVisible.kind, entityKind)] : []),
              ),
            )
            .orderBy(sourcesVisible.name)
            .limit(limit)
        : Promise.resolve([]),
    ]);

    const items = [
      ...productRows.map((p) => ({
        entryType: "product" as const,
        kind: p.kind ?? null,
        id: p.id,
        slug: p.slug,
        name: p.name,
        url: p.url,
        description: p.description,
        category: p.category,
      })),
      ...sourceRows.map((s) => ({
        entryType: "source" as const,
        kind: s.kind ?? null,
        id: s.id,
        slug: s.slug,
        name: s.name,
        type: s.type,
        url: s.url,
        productId: s.productId,
      })),
    ];

    return c.json({
      org: { id: org.id, slug: org.slug, name: org.name },
      items,
    });
  },
);

// Collections this org appears in — either as a direct org member or via one
// of its products — ordered by collection name.
orgRoutes.get(
  "/orgs/:slug/collections",
  describeRoute({
    tags: ["Orgs"],
    summary: "Collections this org belongs to",
    description:
      "Returns the curated collections that include this organization — either because the org itself is a member, or because one of its products is a member (e.g. a `coding-agents` collection that pins Claude Code surfaces on the Anthropic org page). Deduplicated and ordered alphabetically by collection name. Each item includes `memberCount` (visible public orgs + products, matching `GET /v1/collections`). Use `GET /v1/collections/:slug` for the full collection detail.",
    responses: {
      200: {
        description: "Collection membership list",
        content: { "application/json": { schema: resolver(OrgCollectionsResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");

    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    // Surface a collection when the org itself is pinned OR any of the org's
    // visible products is pinned; the IN-subquery dedupes a collection that
    // pins both down to a single row.
    const body = await listCollectionsWhere(
      db,
      sql`c.id IN (
        SELECT cm.collection_id FROM collection_members cm
        WHERE cm.org_id = ${org.id}
           OR cm.product_id IN (SELECT id FROM products_active WHERE org_id = ${org.id})
      )`,
    );
    return c.json(body);
  },
);

orgRoutes.get(
  "/orgs/:slug/accounts",
  describeRoute({
    tags: ["Orgs"],
    summary: "List org social/platform accounts",
    description:
      "Returns the org's registered accounts (GitHub, Twitter, LinkedIn, etc.) as a paginated list. Pass `?platform=<name>` to fetch a single account by platform — returns the account object or `null` when not set. The 200 schema is a union of the paginated list (default) or a single `OrgAccountItem`/`null` (single-mode) — the OSS CLI depends on the single-row return shape.",
    parameters: [
      {
        name: "platform",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "When provided, returns a single `OrgAccountItem` for the given platform (or `null`). When absent, returns the full paginated list.",
      },
    ],
    responses: {
      200: {
        description:
          "Paginated org accounts (default), or a single `OrgAccountItem`/`null` when `?platform=` is supplied",
        content: { "application/json": { schema: resolver(OrgAccountsResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const platform = c.req.query("platform");

    const [org] = await db.select().from(organizations).where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    if (platform) {
      const [account] = await db
        .select({ platform: orgAccounts.platform, handle: orgAccounts.handle })
        .from(orgAccounts)
        .where(and(eq(orgAccounts.orgId, org.id), eq(orgAccounts.platform, platform)));
      return c.json(account ?? null);
    }

    const pagination = parseListPagination(new URL(c.req.url).searchParams);
    const [accounts, totalRow] = await Promise.all([
      db
        .select({ platform: orgAccounts.platform, handle: orgAccounts.handle })
        .from(orgAccounts)
        .where(eq(orgAccounts.orgId, org.id))
        .orderBy(orgAccounts.platform, orgAccounts.handle)
        .limit(pagination.pageSize)
        .offset(pagination.offset),
      db.select({ n: count() }).from(orgAccounts).where(eq(orgAccounts.orgId, org.id)),
    ]);
    return c.json(buildListResponse(accounts, pagination, Number(totalRow[0]?.n ?? 0)));
  },
);

orgRoutes.delete(
  "/orgs/:slug/accounts/:platform/:handle",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Delete org account",
    description:
      "Removes one platform/handle pair from the org. Handles that contain special characters must be URL-encoded in the path. Auth is inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Account deleted",
        content: { "application/json": { schema: resolver(DeleteOrgAccountResponseSchema) } },
      },
      400: {
        description: "Malformed `:handle` path segment",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization or account not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const platform = c.req.param("platform");
    let handle: string;
    try {
      handle = decodeURIComponent(c.req.param("handle"));
    } catch {
      return c.json(
        { error: "bad_request", message: "Malformed URL-encoded `:handle` path segment" },
        400,
      );
    }

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
  },
);

orgRoutes.get(
  "/orgs/:slug/tags",
  describeRoute({
    tags: ["Orgs"],
    summary: "List org tags",
    description:
      "Returns the org's tag names as a paginated list, sorted alphabetically. Returns an empty list (not 404) when the org has no tags.",
    responses: {
      200: {
        description: "Paginated tag name list",
        content: { "application/json": { schema: resolver(OrgTagsResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const [org] = await db.select().from(organizations).where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    const pagination = parseListPagination(new URL(c.req.url).searchParams);
    const [rows, totalRow] = await Promise.all([
      db
        .select({ name: tags.name })
        .from(orgTags)
        .innerJoin(tags, eq(orgTags.tagId, tags.id))
        .where(eq(orgTags.orgId, org.id))
        .orderBy(tags.name)
        .limit(pagination.pageSize)
        .offset(pagination.offset),
      db
        .select({ n: count() })
        .from(orgTags)
        .innerJoin(tags, eq(orgTags.tagId, tags.id))
        .where(eq(orgTags.orgId, org.id)),
    ]);
    return c.json(
      buildListResponse(
        rows.map((r) => r.name),
        pagination,
        Number(totalRow[0]?.n ?? 0),
      ),
    );
  },
);

orgRoutes.put(
  "/orgs/:slug/tags",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Add tags to org",
    description:
      "Adds the supplied tag names to the org (idempotent — existing tags are not duplicated).",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Tags added",
        content: { "application/json": { schema: resolver(OrgTagsMutationResponseSchema) } },
      },
      400: {
        description: "Invalid or malformed request body",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(OrgTagsBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const { tags: tagNames } = c.req.valid("json");
    const [org] = await db.select().from(organizations).where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    if (tagNames.length > 0) {
      const tagRows = await getOrCreateTagsD1(db, tagNames);
      const now = new Date().toISOString();
      await db
        .insert(orgTags)
        .values(tagRows.map((t) => ({ orgId: org.id, tagId: t.id, createdAt: now })))
        .onConflictDoNothing();
    }
    return c.json({ ok: true });
  },
);

orgRoutes.delete(
  "/orgs/:slug/tags",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Remove tags from org",
    description:
      "Removes the supplied tag names from the org. Tags not currently associated with the org are silently skipped.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Tags removed",
        content: { "application/json": { schema: resolver(OrgTagsMutationResponseSchema) } },
      },
      400: {
        description: "Invalid or malformed request body",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(OrgTagsBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const { tags: tagNames } = c.req.valid("json");
    const [org] = await db.select().from(organizations).where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    const slugs = Array.from(new Set(tagNames.map((t) => toSlug(t))));
    if (slugs.length === 0) return c.json({ ok: true });
    // Single DELETE per chunk via a tag-slug subquery — the per-name SELECT
    // phase folds into the DELETE. For the typical request (<= IN_ARRAY_CHUNK_SIZE
    // tags) this is one D1 round-trip total.
    for (let i = 0; i < slugs.length; i += IN_ARRAY_CHUNK_SIZE) {
      const chunk = slugs.slice(i, i + IN_ARRAY_CHUNK_SIZE);
      const tagIdsForSlugs = db.select({ id: tags.id }).from(tags).where(inArray(tags.slug, chunk));
      // oxlint-disable-next-line no-await-in-loop -- chunked DELETE
      await db
        .delete(orgTags)
        .where(and(eq(orgTags.orgId, org.id), inArray(orgTags.tagId, tagIdsForSlugs)));
    }
    return c.json({ ok: true });
  },
);

orgRoutes.post(
  "/tags",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Get or create a global tag",
    description:
      "Looks up a tag by its slugified name. If it already exists, returns the existing row (200). If not, creates it and returns the new row (201). Body: `{ name: string }`. This endpoint is historically co-located in `orgs.ts`; the global tag registry is shared across all orgs and products.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Tag already existed — existing row returned",
        content: { "application/json": { schema: resolver(TagRowSchema) } },
      },
      201: {
        description: "Tag created",
        content: { "application/json": { schema: resolver(TagRowSchema) } },
      },
      400: {
        description: "Missing required field: name",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(CreateTagBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const body = c.req.valid("json");
    const tagSlug = toSlug(body.name);
    const [existing] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
    if (existing) return c.json(existing);

    const [created] = await db
      .insert(tags)
      .values({ name: body.name, slug: tagSlug, createdAt: new Date().toISOString() })
      .returning();
    return c.json(created, 201);
  },
);

// Weekly release activity for timeline visualization
orgRoutes.get(
  "/orgs/:slug/activity",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Org release activity (weekly buckets)",
    description:
      "Returns per-source weekly release buckets across the org, plus an aggregate rollup. Used for timeline / chart visualization. Accepts optional `?from=YYYY-MM-DD` and `?to=YYYY-MM-DD` date bounds — defaults to the earliest/latest release across all sources when omitted.",
    parameters: [
      {
        name: "from",
        in: "query",
        required: false,
        schema: { type: "string", format: "date" },
        description: "Start date (inclusive, YYYY-MM-DD). Defaults to oldest release date.",
      },
      {
        name: "to",
        in: "query",
        required: false,
        schema: { type: "string", format: "date" },
        description: "End date (inclusive, YYYY-MM-DD). Defaults to newest release date.",
      },
    ],
    responses: {
      200: {
        description: "Activity data",
        content: { "application/json": { schema: resolver(OrgActivityResponseSchema) } },
      },
      400: {
        description: "Invalid date format or range",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
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
  },
);

// Daily release heatmap for contribution-graph visualization
orgRoutes.get(
  "/orgs/:slug/heatmap",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Org release heatmap (daily counts)",
    description:
      "Returns daily release counts for the trailing 365 days — used for the contribution-graph visualization on the org detail page. Range is fixed server-side; no date parameters accepted.",
    responses: {
      200: {
        description: "Heatmap data",
        content: { "application/json": { schema: resolver(OrgHeatmapResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
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
  },
);

// Per-source and per-product sparklines (30-day daily release counts)
orgRoutes.get(
  "/orgs/:slug/sparklines",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Org sparklines (30-day per-source breakdown)",
    description:
      "Returns 30-day daily release counts broken down per source and per product, plus an aggregate rollup. Used for the sparkline charts on the org detail page. Resolves domain aliases in addition to slugs and `org_…` IDs.",
    responses: {
      200: {
        description: "Sparkline data",
        content: { "application/json": { schema: resolver(OrgSparklinesResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
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
  },
);

// Combined release feed for an org
orgRoutes.get(
  "/orgs/:slug/releases",
  describeRoute({
    tags: ["Orgs"],
    summary: "Org release feed (cursor-paginated)",
    description:
      "Returns the org's combined release feed across all sources, newest-first. Cursor-paginated — pass `nextCursor` from the previous response as `?cursor=` on the next request. Accepts `?source_type=`, `?kind=`, `?include_coverage=true`, `?include_prereleases=true`, and `?q=` full-text search.",
    parameters: [
      {
        name: "cursor",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "Opaque cursor from a previous response's `pagination.nextCursor`.",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        description: "Max releases to return. Defaults to 20, capped at 100.",
      },
      {
        name: "source_type",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "Filter by source type (e.g. `github`, `feed`, `scrape`).",
      },
      {
        name: "kind",
        in: "query",
        required: false,
        schema: { type: "string", enum: KIND_VALUES as unknown as string[] },
        description: `Filter by resolved entity kind (source.kind ?? product.kind). One of: ${KIND_VALUES.join(", ")}.`,
      },
      {
        name: "product",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Restrict the feed to one product (slug or `prod_…` id, scoped to this org). Unknown product → 404.",
      },
      {
        name: "include_coverage",
        in: "query",
        required: false,
        schema: { type: "boolean" },
        description: "When true, include coverage-side rows (hidden by default).",
      },
      {
        name: "include_prereleases",
        in: "query",
        required: false,
        schema: { type: "boolean" },
        description: "When true, include pre-release entries.",
      },
      {
        name: "q",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "Full-text search query applied to release title and content.",
      },
      {
        name: "since",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Keep only releases published at or after this bound. Accepts an ISO date/datetime or relative shorthand (`90d`, `4w`, `6m`, `2y`). Filters `published_at`; undated releases are dropped.",
      },
      {
        name: "until",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Keep only releases published at or before this bound. Same input formats as `since`.",
      },
    ],
    responses: {
      200: {
        description: "Release feed",
        content: {
          "application/json": { schema: resolver(OrgReleasesFeedResponseSchema) },
          "text/markdown": { schema: { type: "string" } },
        },
      },
      400: {
        description: "Invalid `kind` value or unparseable `since`/`until`",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const slug = c.req.param("slug");
    const cursorParam = c.req.query("cursor") ?? null;
    const limit = parseLimitParam(c.req.query("limit"), 20, 100);
    const includeCoverage = parseBoolParam(c.req.query("include_coverage"));
    const includePrereleases = parseBoolParam(c.req.query("include_prereleases"));
    const sourceTypes = parseSourceTypesLenient(c.req.query("source_type"));
    const qRaw = c.req.query("q")?.trim() ?? "";
    const ftsMatch = qRaw ? toFtsPrefixMatchQuery(qRaw) : undefined;

    const kind = parseKindParam(c.req.query("kind"));
    if (kind === null)
      return c.json(
        {
          error: "bad_request",
          message: `Invalid kind. Expected one of: ${KIND_VALUES.join(", ")}`,
        },
        400,
      );

    const window = parseTimeWindow(c.req.query("since"), c.req.query("until"));
    if (!window.ok) return c.json({ error: "bad_request", message: window.message }, 400);

    const db = createDb(c.env.DB);

    // Resolve org
    const org = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(orgWhere(slug))
      .get();

    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    const productParam = c.req.query("product");
    let productId: string | undefined;
    if (productParam) {
      const product = await findProductForOrgSlug(db, slug, productParam);
      if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);
      productId = product.id;
    }

    const results = await getOrgReleasesFeed(
      c.env.DB,
      org.id,
      parseFeedCursor(cursorParam),
      limit + 1,
      {
        includeCoverage,
        sourceTypes,
        includePrereleases,
        ftsMatch,
        kind,
        productId,
        since: window.since,
        until: window.until,
      },
    );

    const hasMore = results.length > limit;
    const pageRows = hasMore ? results.slice(0, limit) : results;

    // Build next cursor from last item
    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      nextCursor = buildFeedCursor(pageRows[pageRows.length - 1]);
    }

    const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
    const releasesFormatted = pageRows.map((r) => {
      const appStore = appStoreSourceInfo(r.source_type, r.source_metadata);
      const video = videoSourceInfo(r.source_type, r.source_metadata) ?? undefined;
      const product = r.product_slug
        ? { slug: r.product_slug, name: r.product_name ?? r.product_slug }
        : null;
      return {
        id: r.id,
        version: r.version,
        type: r.type,
        title: r.title,
        summary:
          r.summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
        titleGenerated: r.title_generated,
        titleShort: r.title_short,
        content: hydrateMediaUrls(r.content, mediaOrigin),
        publishedAt: r.published_at,
        url: r.url,
        media: parseReleaseMedia(r.media, mediaOrigin),
        prerelease: r.prerelease === 1,
        source: {
          slug: r.source_slug,
          name: r.source_name,
          type: r.source_type,
          appStore: appStore ?? undefined,
          video,
        },
        product,
        // Resolved grouping identity — COALESCE(product, source). Lets the web
        // feed key/label SDK-cluster rollups without reconstructing it. #1234
        groupSlug: product?.slug ?? r.source_slug,
        groupName: product?.name ?? r.source_name,
        coverageCount: r.coverage_count,
        contentChars: r.content_chars,
        contentTokens: r.content_tokens,
        composition: parseCompositionFromMetadata(r.metadata),
      };
    });

    const pagination = { nextCursor, limit };

    if (wantsMarkdown(c)) {
      return markdownResponse(c, orgReleaseFeedToMarkdown(slug, releasesFormatted, pagination));
    }

    return c.json({ releases: releasesFormatted, pagination });
  },
);

// ---------------------------------------------------------------------------
// GET /orgs/:slug/recent-releases?since=<iso>&limit=<n>
//
// Returns releases for grouping / summarization — same shape as the local
// getRecentReleasesByOrg query (full Release row + sourceName/sourceSlug),
// filtered to `publishedAt >= since` and skipping suppressed + disabled.
// ---------------------------------------------------------------------------

orgRoutes.get(
  "/orgs/:slug/recent-releases",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Recent releases for an org (agent summarization)",
    description:
      "Returns the full release rows published since `?since=<ISO>` for all visible sources in the org. Intended for agent-driven summarization and grouping — includes `content`, `media`, and `metadata` fields that the public feed omits. Requires `since` (ISO date/datetime); `limit` defaults to 500, capped at 2000.",
    parameters: [
      {
        name: "since",
        in: "query",
        required: true,
        schema: { type: "string", format: "date-time" },
        description: "Return releases published at or after this ISO date/datetime.",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 2000, default: 500 },
        description: "Max releases to return. Defaults to 500, capped at 2000.",
      },
    ],
    responses: {
      200: {
        description: "Recent release rows",
        content: { "application/json": { schema: resolver(OrgRecentReleasesResponseSchema) } },
      },
      400: {
        description: "Missing required `since` parameter",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
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
    // Validate AND normalize ISO format — `since` is bound directly into a
    // `gte` clause against `publishedAt` (string column). Date.parse accepts
    // permissive shapes like `2024/01/01` that pass the NaN check but sort
    // lexically against the ISO column. Convert to a canonical ISO string
    // so the SQL comparison is always against a well-formed UTC timestamp.
    const sinceDate = new Date(since);
    if (Number.isNaN(sinceDate.getTime())) {
      return c.json(
        {
          error: "bad_request",
          message: "Invalid `since` query param — must be an ISO date or datetime",
        },
        400,
      );
    }
    const sinceIso = sinceDate.toISOString();

    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    const rows = await db
      .select({
        id: releasesVisible.id,
        sourceId: releasesVisible.sourceId,
        version: releasesVisible.version,
        type: releasesVisible.type,
        title: releasesVisible.title,
        content: releasesVisible.content,
        summary: releasesVisible.summary,
        titleGenerated: releasesVisible.titleGenerated,
        titleShort: releasesVisible.titleShort,
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
      .where(and(eq(sourcesVisible.orgId, org.id), gte(releasesVisible.publishedAt, sinceIso)))
      .orderBy(desc(releasesVisible.publishedAt))
      .limit(limit);

    return c.json(rows);
  },
);

orgRoutes.post(
  "/orgs/:slug/accounts",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Add a platform account to an org",
    description:
      "Registers a new platform/handle pair for the org. Both `platform` and `handle` are required. Duplicate platform/handle pairs return 409. Auth is inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: "Account created",
        content: { "application/json": { schema: resolver(OrgAccountItemSchema) } },
      },
      400: {
        description: "Missing required fields",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      409: {
        description: "Account already exists for this platform/handle",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(AddOrgAccountBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const body = c.req.valid("json");

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
        .returning({ platform: orgAccounts.platform, handle: orgAccounts.handle });
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
  },
);

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
      ...dbErrorLogFields(err),
    });
  }
}
