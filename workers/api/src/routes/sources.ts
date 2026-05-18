import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { hideInProduction } from "../openapi.js";
import {
  eq,
  desc,
  count,
  and,
  or,
  min,
  isNull,
  isNotNull,
  sql,
  gte,
  inArray,
  type SQL,
} from "drizzle-orm";
import { createDb } from "../db.js";
import {
  sources,
  sourcesActive,
  sourcesVisible,
  releases,
  releasesVisible,
  organizations,
  organizationsActive,
  releaseSummaries,
  products,
  sourceChangelogFiles,
  type ReleaseType,
} from "@buildinternet/releases-core/schema";
import { SOURCE_TYPES, type SourceType } from "@buildinternet/releases-core/source-enums";
import { buildListResponse, parseListPagination } from "../lib/pagination.js";
import { RELEASE_URL_UPSERT } from "@releases/core-internal/release-upsert";
import { daysAgoIso, inferMonthOnlyDate } from "@buildinternet/releases-core/dates";
import { parseCompositionFromMetadata } from "@buildinternet/releases-core/composition";
import { buildCompositionMetadataSet } from "@releases/core-internal/composition-metadata";
import { likeContains } from "@buildinternet/releases-core/sql-like";
import { toSlug } from "@buildinternet/releases-core/slug";
import { isReservedSlug } from "@buildinternet/releases-core/reserved-slugs";
import {
  buildChangelogResponse,
  selectChangelogFile,
} from "@buildinternet/releases-core/changelog-slice";
import type { SourceWithOrg, SourcePatchInput } from "@buildinternet/releases-api-types";
import {
  SourceListResultSchema,
  SourceDetailSchema,
  SourceMutationResponseSchema,
  SourceChangelogResponseSchema,
  CreateSourceBodySchema,
  SourceContentHashBodySchema,
  ErrorResponseSchema,
  ReleaseDetailResponseSchema,
  ReleasePatchResponseSchema,
  ReleaseDeleteResponseSchema,
  ReleaseSuppressBodySchema,
  ReleaseSuppressResponseSchema,
  ReleaseUnsuppressResponseSchema,
  UpdateReleaseBodySchema,
  SourceActivityResponseSchema,
  SourceHeatmapResponseSchema,
  SourceKnownReleasesResponseSchema,
  SourceRecentReleasesResponseSchema,
  SourceSessionsResponseSchema,
  SourceFetchResponseSchema,
  SourceContentHashResponseSchema,
  ChangelogTokensResponseSchema,
  SourceMetadataResponseSchema,
  ChangelogProbeResponseSchema,
  DeleteSourceResponseSchema,
  DeleteSourceReleasesResponseSchema,
  InsertReleaseResponseSchema,
  BatchReleasesResponseSchema,
  OversizedChangelogFilesResponseSchema,
  FetchableSourcesResponseSchema,
  FeedSourcesResponseSchema,
  ChangedSourcesResponseSchema,
} from "@buildinternet/releases-api-types";
import { validateJson } from "../lib/validate.js";
import {
  getStatusHub,
  orgWhere,
  isProductId,
  buildFeedCursor,
  parseFeedCursor,
  parseLimitParam,
  resolveSourceFromContext,
  isConflictError,
  computeAvgPerWeek,
  heatmapDateRange,
  hydrateMediaUrls,
  parseReleaseMedia,
  parseBoolParam,
  parseEnumParam,
  parseSortDir,
} from "../utils.js";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { authMiddleware } from "../middleware/auth.js";
import { sourceToMarkdown, releaseToMarkdown } from "@releases/rendering/formatters.js";
import { fetchOne, embedReleasesForSource } from "../cron/poll-fetch.js";
import { getSourceMeta, isGitHubFetched } from "@releases/adapters/feed.js";
import { sanitizeVersion } from "@releases/adapters/extract/shared.js";
import {
  discoverChangelogPaths,
  buildGitHubHeaders,
  parseOwnerRepo,
} from "@releases/adapters/github-discovery";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { CHANGELOG_MAX_FILES } from "@releases/adapters/github";
import { isPrereleaseVersion } from "@buildinternet/releases-core/prerelease";
import { computeVersionSort } from "@buildinternet/releases-core/version-sort";
import { computeContentSize } from "@buildinternet/releases-core/tokens";
import type { Env } from "../index.js";
import {
  getSourcesWithStats,
  countSourcesForList,
  getSourceReleasesPaginated,
  getSourceReleasesFeed,
  getSourceActivityBuckets,
  getSourceHeatmapData,
  SOURCE_SORT_FIELDS,
} from "../queries/sources.js";
import { toFtsPrefixMatchQuery } from "@buildinternet/releases-core/fts";
import { regeneratePlaybook } from "../playbook-regen.js";
import { embedAndUpsertReleases } from "@releases/search/embed-releases.js";
import { embedAndUpsertEntities, type EntityKind } from "@releases/search/embed-entities.js";
import { publishReleaseEvents } from "../events/publish.js";
import type { InsertedReleaseRow } from "../events/build-event.js";
import { buildEmbedConfig } from "../lib/embed-config.js";
import {
  RELEASES_BATCH_CHUNK_SIZE,
  RELEASES_ID_IN_CHUNK_SIZE,
  IN_ARRAY_CHUNK_SIZE,
} from "../lib/d1-limits.js";
import { invalidateLatestCache } from "../lib/latest-cache.js";
import { notifyIndexNowForSource } from "../lib/indexnow.js";
import { clusterAndPersistCascades } from "../lib/cluster-cascades.js";
import { resolveOrgSlug, resolveProductSlug } from "../lib/slug-lookups.js";
import { logEvent } from "@releases/lib/log-event";
import { classifyDbError } from "@releases/lib/db-errors";
import { getSecret } from "@releases/lib/secrets";

export const sourceRoutes = new Hono<Env>();

/**
 * Narrow a parsed JSON body to a non-null, non-array object. `await c.req.json()`
 * happily returns `null`, arrays, or primitives (all valid JSON), and the
 * downstream `body.<field>` access on those values either throws (`null`) or
 * silently returns `undefined` for fields like `body.title` (arrays/strings).
 * Callers should `return c.json({ error: "bad_request", ... }, 400)` on `false`.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve `org { id, slug, name }` and `productSlug` for a source row, both
 * in a single batched read. Returned shape matches `SourceMutationResponse`
 * — see `packages/api-types/src/schemas/sources.ts` for the contract.
 *
 * Used by the create / update / detail handlers so callers can answer
 * "did the write take?" from the response alone instead of round-tripping
 * a follow-up GET (issue #794).
 */
async function attachSourceAttribution<
  T extends { id: string; orgId: string | null; productId: string | null },
>(
  db: ReturnType<typeof createDb>,
  src: T,
): Promise<
  T & { org: { id: string; slug: string; name: string } | null; productSlug: string | null }
> {
  const [orgRows, productRows] = await Promise.all([
    src.orgId
      ? db
          .select({ id: organizations.id, slug: organizations.slug, name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, src.orgId))
          .limit(1)
      : Promise.resolve([] as Array<{ id: string; slug: string; name: string }>),
    src.productId
      ? db
          .select({ slug: products.slug })
          .from(products)
          .where(eq(products.id, src.productId))
          .limit(1)
      : Promise.resolve([] as Array<{ slug: string }>),
  ]);
  return {
    ...src,
    org: orgRows[0] ?? null,
    productSlug: productRows[0]?.slug ?? null,
  };
}

sourceRoutes.get(
  "/sources",
  describeRoute({
    tags: ["Sources"],
    summary: "List sources",
    description:
      "Returns a bare array by default; pass `?envelope=true` for the paginated `{items, pagination}` shape. Filter by `?orgId=`, `?orgSlug=`, `?productSlug=`, `?type=`, `?has_feed=`, `?stale=`, `?category=`, `?independent=true`, `?hasChangelog=false` (sources with no tracked CHANGELOG file), `?minRels30d=N` (sources with at least N visible releases in the last 30 days). Free-text search via `?q=`.",
    responses: {
      200: {
        description: "Sources (bare array unless `?envelope=true`)",
        content: { "application/json": { schema: resolver(SourceListResultSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const independent = c.req.query("independent") === "true";
    const orgId = c.req.query("orgId");
    const orgSlug = c.req.query("orgSlug");
    const filterByUrls = c.req.query("filterByUrls") === "true";
    const hasFeed = c.req.query("has_feed") === "true";
    // Accept both ?q= (server-side search alias) and legacy ?query=
    const queryText = c.req.query("q") ?? c.req.query("query");
    const includeHidden = c.req.query("include_hidden") === "true";
    const categoryFilter = c.req.query("category");

    // Pagination: default limit 100, hard cap 500. `?offset=` is also accepted
    // and overrides `?page=` so callers that pre-compute offsets keep working.
    const url = new URL(c.req.url);
    const offsetParam = c.req.query("offset");
    const pagination = parseListPagination(url.searchParams, {
      defaultPageSize: 100,
      maxPageSize: 500,
    });
    const { page, pageSize: limit } = pagination;
    const rawOffset = offsetParam ? parseInt(offsetParam, 10) : pagination.offset;
    const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

    // Filter by URLs — return raw source rows matching the provided url params.
    // URLs come from query string, so chunk at the D1 100-bind cap.
    if (filterByUrls) {
      const urls = c.req.queries("url") ?? [];
      if (urls.length === 0) return c.json([]);
      const rows: (typeof sources.$inferSelect)[] = [];
      for (let i = 0; i < urls.length; i += IN_ARRAY_CHUNK_SIZE) {
        const chunk = urls.slice(i, i + IN_ARRAY_CHUNK_SIZE);
        // oxlint-disable-next-line no-await-in-loop -- sequential chunks under the D1 bind-param cap
        const chunkRows = await db.select().from(sources).where(inArray(sources.url, chunk));
        rows.push(...chunkRows);
      }
      return c.json(rows);
    }

    // Build conditions for metadata-based filters
    const conditions = [];

    if (independent) {
      conditions.push(isNull(sources.orgId));
    }

    // Filter by org ID. Folded into `conditions` so the new ?hasChangelog,
    // ?minRels30d, and ?envelope filters compose with `?orgId=` instead of
    // taking the legacy fast-path that returns a bare unfiltered array.
    if (orgId) {
      conditions.push(eq(sources.orgId, orgId));
    }

    // Resolve org by slug
    let resolvedOrgId: string | undefined;
    if (orgSlug) {
      const [org] = await db.select().from(organizations).where(orgWhere(orgSlug));
      if (!org) return c.json([]);
      resolvedOrgId = org.id;
      conditions.push(eq(sources.orgId, org.id));
    }

    // `productSlug` query param accepts a `prod_` ID (matched globally) or a
    // slug. Slugs are unique per-org (idx_products_org_slug), so when orgSlug
    // is present we resolve to a single product in that org. Without orgSlug,
    // we fan out to every product sharing the slug and filter sources to that
    // ID set — picking the first row would silently mask cross-org duplicates
    // if any ever land. There are none on prod today; this is the safe shape.
    const productSlug = c.req.query("productSlug");
    if (productSlug) {
      if (isProductId(productSlug)) {
        const [product] = await db
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.id, productSlug), isNull(products.deletedAt)))
          .limit(1);
        if (!product) return c.json([]);
        conditions.push(eq(sources.productId, product.id));
      } else {
        const slugMatch = resolvedOrgId
          ? and(eq(products.slug, productSlug), eq(products.orgId, resolvedOrgId))
          : eq(products.slug, productSlug);
        const matches = await db
          .select({ id: products.id })
          .from(products)
          .where(and(slugMatch, isNull(products.deletedAt)));
        if (matches.length === 0) return c.json([]);
        if (matches.length === 1) {
          conditions.push(eq(sources.productId, matches[0]!.id));
        } else {
          const ids = matches.map((m) => m.id);
          const chunks: SQL[] = [];
          for (let i = 0; i < ids.length; i += IN_ARRAY_CHUNK_SIZE) {
            chunks.push(inArray(sources.productId, ids.slice(i, i + IN_ARRAY_CHUNK_SIZE)));
          }
          // OR the chunks together so the WHERE clause stays under D1's
          // 100-bind cap even if a slug ever fans out to >90 products.
          conditions.push(chunks.length === 1 ? chunks[0]! : or(...chunks)!);
        }
      }
    }

    if (hasFeed) {
      conditions.push(
        sql`json_extract(${sources.metadata}, '$.feedUrl') IS NOT NULL AND json_extract(${sources.metadata}, '$.feedUrl') != ''`,
      );
    }

    if (queryText) {
      const lower = queryText.toLowerCase();
      conditions.push(
        or(
          likeContains(sql`lower(${sources.name})`, lower),
          likeContains(sql`lower(${sources.slug})`, lower),
          likeContains(sql`lower(${sources.url})`, lower),
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

    const rawType = c.req.query("type");
    if (rawType && (SOURCE_TYPES as readonly string[]).includes(rawType)) {
      conditions.push(eq(sources.type, rawType as SourceType));
    }

    const staleOnly = parseBoolParam(c.req.query("stale"));

    // `?hasChangelog=false` filters to sources with NO row in
    // `source_changelog_files`. The `=true` form (only sources that DO have
    // a changelog) is intentionally not implemented — the use case is
    // operator-driven attach workflows, not an inverse listing.
    const missingChangelog = c.req.query("hasChangelog") === "false";
    const minRels30dRaw = c.req.query("minRels30d");
    let minReleasesLast30Days: number | undefined;
    if (minRels30dRaw != null) {
      const parsed = parseInt(minRels30dRaw, 10);
      if (Number.isFinite(parsed) && parsed > 0) minReleasesLast30Days = parsed;
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const wantsEnvelope = c.req.query("envelope") === "true";

    const sort = parseEnumParam(c.req.query("sort"), SOURCE_SORT_FIELDS, "name");
    const dir = parseSortDir(c.req.query("dir"), "asc");

    const filterOpts = {
      includeHidden,
      staleOnly,
      missingChangelog,
      minReleasesLast30Days,
    };
    const [rows, totalItems] = await Promise.all([
      getSourcesWithStats(db, whereClause, { limit, offset, sort, dir, ...filterOpts }),
      wantsEnvelope ? countSourcesForList(db, whereClause, filterOpts) : Promise.resolve(null),
    ]);

    // Derive page from offset when caller pre-computed it — keeps the envelope's
    // page/hasMore accurate for `?offset=...` callers that skip `?page=...`.
    const effectivePage = offsetParam ? Math.floor(offset / limit) + 1 : page;

    const result: SourceWithOrg[] = rows.map((src) => ({
      id: src.id,
      slug: src.slug,
      name: src.name,
      type: src.type,
      url: src.url,
      orgSlug: src.org_slug,
      orgName: src.org_name,
      productName: src.product_name,
      productSlug: src.product_slug,
      isPrimary: Boolean(src.is_primary),
      isHidden: Boolean(src.is_hidden),
      discovery: src.discovery ?? "curated",
      metadata: src.metadata ?? null,
      releaseCount: src.release_count,
      latestVersion: src.latest_version ?? null,
      latestDate: src.latest_date ?? null,
      lastFetchedAt: src.last_fetched_at ?? null,
      lastPolledAt: src.last_polled_at ?? null,
      fetchPriority: src.fetch_priority ?? null,
      changeDetectedAt: src.change_detected_at ?? null,
      consecutiveNoChange: src.consecutive_no_change ?? 0,
      consecutiveErrors: src.consecutive_errors ?? 0,
      nextFetchAfter: src.next_fetch_after ?? null,
      medianGapDays: src.median_gap_days ?? null,
      lastRetieredAt: src.last_retiered_at ?? null,
    }));

    if (wantsEnvelope && totalItems != null) {
      return c.json(
        buildListResponse(result, { page: effectivePage, pageSize: limit, offset }, totalItems),
      );
    }

    return c.json(result);
  },
);

// ── Fetchable sources (must be before :slug route) ──

const getFetchableSourcesRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "List fetchable sources",
  description:
    "Returns visible source rows that are eligible for a fetch pass. `?mode=unfetched` returns sources with no prior fetch; `?mode=stale` (requires `?staleHours=N`) returns sources whose last fetch is older than N hours and whose `nextFetchAfter` has passed; `?mode=retry_errors` returns sources whose most-recent fetch log entry has `status = 'error'`; `?mode=all` (default) returns all visible sources. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Fetchable source rows",
      content: { "application/json": { schema: resolver(FetchableSourcesResponseSchema) } },
    },
  },
});
sourceRoutes.get("/sources/fetchable", getFetchableSourcesRoute, async (c) => {
  const db = createDb(c.env.DB);
  const mode = c.req.query("mode"); // "unfetched" | "stale" | "retry_errors" | "all"
  const staleHours = c.req.query("staleHours");

  let rows: (typeof sources.$inferSelect)[];

  if (mode === "unfetched") {
    rows = await db
      .select()
      .from(sourcesVisible)
      .where(sql`${sourcesVisible.lastFetchedAt} IS NULL`);
  } else if (mode === "stale" && staleHours) {
    const hours = parseInt(staleHours, 10);
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    const now = new Date().toISOString();
    rows = await db
      .select()
      .from(sourcesVisible)
      .where(
        and(
          sql`(${sourcesVisible.lastFetchedAt} IS NULL OR ${sourcesVisible.lastFetchedAt} < ${cutoff})`,
          sql`(${sourcesVisible.nextFetchAfter} IS NULL OR ${sourcesVisible.nextFetchAfter} <= ${now})`,
          sql`${sourcesVisible.fetchPriority} != 'paused'`,
        ),
      );
  } else if (mode === "retry_errors") {
    rows = await db
      .select()
      .from(sourcesVisible)
      .where(
        sql`${sourcesVisible.id} IN (
          SELECT f.source_id FROM fetch_log f
          WHERE f.id = (SELECT f2.id FROM fetch_log f2 WHERE f2.source_id = f.source_id ORDER BY f2.created_at DESC LIMIT 1)
          AND f.status = 'error'
        )`,
      );
  } else {
    rows = await db.select().from(sourcesVisible);
  }

  return c.json(rows);
});

// ── Feed and change-detection sources (must be before :slug route) ──

const getFeedSourcesRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "List feed sources",
  description:
    "Returns visible source rows where `metadata.feedUrl` is set and `fetchPriority != 'paused'`. Used by the poll-and-fetch cron to enumerate sources that can be fetched via RSS/Atom/JSON feed. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Sources with a discovered feed URL",
      content: { "application/json": { schema: resolver(FeedSourcesResponseSchema) } },
    },
  },
});
sourceRoutes.get("/sources/feeds", getFeedSourcesRoute, async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(sourcesVisible)
    .where(
      and(
        sql`json_extract(${sourcesVisible.metadata}, '$.feedUrl') IS NOT NULL`,
        sql`${sourcesVisible.fetchPriority} != 'paused'`,
      ),
    );
  return c.json(rows);
});

const getChangedSourcesRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "List sources with pending changes",
  description:
    "Returns visible source rows with a non-null `changeDetectedAt` — the set flagged for CLI pickup after a scrape or agent run detects new content. The CLI clears `changeDetectedAt` after fetching the source. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Sources pending a fetch",
      content: { "application/json": { schema: resolver(ChangedSourcesResponseSchema) } },
    },
  },
});
sourceRoutes.get("/sources/changes", getChangedSourcesRoute, async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(sourcesVisible)
    .where(isNotNull(sourcesVisible.changeDetectedAt));
  return c.json(rows);
});

// ── Trigger fetch for a single source ──

const postSourceFetchRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Trigger a source fetch",
  description:
    "Triggers an immediate fetch for the source identified by slug or `src_…` ID. For feed/GitHub sources (or scrape sources with a discovered feedUrl) the server performs the fetch inline and returns the result. For scrape/agent sources without a feedUrl, the server sets `changeDetectedAt` to flag the source for CLI pickup and returns `{ queued: true }`. Optional query params: `?sessionId=` (associates the fetch with a discovery session), `?dryRun=true` (runs the parser but does not write to D1), `?max=N` (limits entries parsed). Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Fetch result or queue confirmation",
      content: { "application/json": { schema: resolver(SourceFetchResponseSchema) } },
    },
    400: {
      description: "Invalid `max` parameter",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.post("/sources/:slug/fetch", postSourceFetchRoute, async (c) => {
  const db = createDb(c.env.DB);
  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  let responsePayload: Record<string, unknown>;

  const meta = getSourceMeta(src);
  if (
    src.type === "feed" ||
    isGitHubFetched(src, meta) ||
    (src.type === "scrape" && meta.feedUrl != null)
  ) {
    // Feed, GitHub, and scrape sources with a discovered feedUrl: fetch server-side
    const githubToken = (await getSecret(c.env.GITHUB_TOKEN)) ?? undefined;
    const sessionId = c.req.query("sessionId") ?? undefined;
    const dryRun = c.req.query("dryRun") === "true" || c.req.query("dryRun") === "1";
    const maxRaw = c.req.query("max");
    const maxParsed = maxRaw ? Number.parseInt(maxRaw, 10) : null;
    if (maxRaw && (!Number.isFinite(maxParsed) || maxParsed! <= 0)) {
      return c.json({ error: "invalid_max", message: "max must be a positive integer" }, 400);
    }
    const result = await fetchOne(
      db,
      src,
      {
        GITHUB_TOKEN: githubToken,
        RELEASES_INDEX: c.env.RELEASES_INDEX,
        CHANGELOG_CHUNKS_INDEX: c.env.CHANGELOG_CHUNKS_INDEX,
        EMBEDDING_PROVIDER: c.env.EMBEDDING_PROVIDER,
        VOYAGE_API_KEY: c.env.VOYAGE_API_KEY,
        OPENAI_API_KEY: c.env.OPENAI_API_KEY,
        RELEASE_HUB: c.env.RELEASE_HUB,
        WEBHOOK_DELIVERY_QUEUE: c.env.WEBHOOK_DELIVERY_QUEUE,
        DB: c.env.DB,
        DISCOVERY_WORKER: c.env.DISCOVERY_WORKER,
      },
      { sessionId, dryRun, maxEntries: maxParsed ?? undefined },
    );
    responsePayload = { fetched: true, ...result };
    if (result.releasesInserted > 0) {
      c.executionCtx.waitUntil(
        invalidateLatestCache(c.env, {
          nReleases: result.releasesInserted,
          sourceId: src.id,
        }),
      );
    }
  } else {
    // Scrape and agent sources: flag for CLI pickup
    await db
      .update(sources)
      .set({
        changeDetectedAt: new Date().toISOString(),
      })
      .where(eq(sources.id, src.id));
    responsePayload = { queued: true, type: "flagged" };
  }

  // Emit status event for dashboard feedback
  const hub = getStatusHub(c.env);
  await hub.fetch(
    new Request("https://do/event", {
      method: "POST",
      body: JSON.stringify({
        type: "fetch:triggered",
        sourceSlug: src.slug,
        sourceName: src.name,
        sourceType: src.type,
        ...responsePayload,
      }),
      headers: { "Content-Type": "application/json" },
    }),
  );

  return c.json(responsePayload);
});

// ── Batch release insert for fetch command ──

const postReleasesBatchHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const body = await c.req.json<{
    releases: Array<{
      version?: string | null;
      title: string;
      content: string;
      url?: string | null;
      contentHash?: string;
      publishedAt?: string | null;
      media?: string | null;
      type?: ReleaseType;
      prerelease?: boolean;
    }>;
  }>();

  try {
    // D1 caps prepared statements at 100 bound parameters — see
    // `../lib/d1-limits.ts` for the math behind the chunk size.
    let inserted = 0;
    const publishRows: InsertedReleaseRow[] = [];
    // Parallel collection of fresh rows-with-content for changesets
    // clustering. We can't run the clusterer off `publishRows` because
    // those omit `content` (the publish payload doesn't need it).
    const clusterRows: Array<{ id: string; version: string | null; content: string }> = [];
    for (let i = 0; i < body.releases.length; i += RELEASES_BATCH_CHUNK_SIZE) {
      const chunk = body.releases.slice(i, i + RELEASES_BATCH_CHUNK_SIZE).map((r) => {
        // LLM-driven agent fetches occasionally emit literal placeholders
        // ("<UNKNOWN>", "n/a", "none") instead of omitting the version.
        // The web frontend promotes a non-null version to the heading slot
        // and demotes title to a byline, so a placeholder leaks all the way
        // to the UI. Strip them here as a server-side safety net — the AI
        // extract path already calls `sanitizeVersion` on its own output.
        // Type-guard the JSON: sanitizeVersion calls .trim(), which would
        // throw on a number or object payload (the body type is the request
        // contract, not a runtime guarantee).
        const version = typeof r.version === "string" ? (sanitizeVersion(r.version) ?? null) : null;
        // Mirror the version type-guard: the helper expects a string, and a
        // non-string title would crash .match() and 500 the whole batch.
        const inferredPublishedAt =
          typeof r.title === "string" ? inferMonthOnlyDate(r.title) : null;
        const size = computeContentSize(r.content);
        return {
          sourceId: src.id,
          version,
          versionSort: computeVersionSort(version),
          type: r.type ?? "feature",
          title: r.title,
          content: r.content,
          url: r.url ?? null,
          contentHash: r.contentHash ?? null,
          contentChars: size.contentChars,
          contentTokens: size.contentTokens,
          publishedAt: r.publishedAt ?? inferredPublishedAt ?? null,
          prerelease: r.prerelease ?? isPrereleaseVersion(version),
          media: r.media ?? "[]",
        };
      });
      // RETURNING is built here — not zipped against `chunk` — because
      // RELEASE_URL_UPSERT has a conditional WHERE clause that causes the
      // database to omit rows where the update didn't apply. The returned
      // rows are the authoritative set of affected ids + content.
      // oxlint-disable-next-line no-await-in-loop -- D1 chunked insert (100 bind param limit)
      const rows = await db
        .insert(releases)
        .values(chunk)
        .onConflictDoUpdate(RELEASE_URL_UPSERT)
        .returning({
          id: releases.id,
          title: releases.title,
          version: releases.version,
          publishedAt: releases.publishedAt,
          media: releases.media,
          content: releases.content,
          contentChars: releases.contentChars,
          contentTokens: releases.contentTokens,
        });
      inserted += rows.length;
      for (const r of rows) {
        const { content, ...publishRow } = r;
        publishRows.push(publishRow);
        clusterRows.push({ id: r.id, version: r.version, content });
      }
    }
    const insertedIds = publishRows.map((r) => r.id);

    // Detect changesets cascade rows and demote them to coverage so they
    // don't dominate the feed, broadcast on the live tail, or trigger an
    // IndexNow ping per row. Synchronous — we want coverage state visible
    // to the downstream waitUntils, not racing them.
    const cascadeResult = await clusterAndPersistCascades(db, clusterRows, {
      component: "sources-batch",
      sourceId: src.id,
    });
    const visiblePublishRows =
      cascadeResult.coverageIds.size > 0
        ? publishRows.filter((r) => !cascadeResult.coverageIds.has(r.id))
        : publishRows;

    const [{ n: total }] = await db
      .select({ n: count() })
      .from(releases)
      .where(eq(releases.sourceId, src.id));

    // Fire-and-forget publish to the ReleaseHub DO so subscribers (CLI
    // `tail -f`, the upcoming web live view, webhook delivery) see new
    // releases in real time. Coverage-side rows are excluded — they're
    // not shown in default feeds and shouldn't broadcast on the live tail
    // either.
    if (visiblePublishRows.length > 0) {
      c.executionCtx.waitUntil(
        publishReleaseEvents(c.env, {
          src: { name: src.name, slug: src.slug, orgId: src.orgId, sourceId: src.id },
          inserted: visiblePublishRows,
        }),
      );
      c.executionCtx.waitUntil(
        invalidateLatestCache(c.env, {
          nReleases: visiblePublishRows.length,
          sourceId: src.id,
        }),
      );
      c.executionCtx.waitUntil(
        notifyIndexNowForSource(
          c.env,
          {
            resolveOrgSlug: (id) => resolveOrgSlug(db, id),
            resolveProductSlug: (id) => resolveProductSlug(db, id),
          },
          {
            slug: src.slug,
            orgId: src.orgId,
            productId: src.productId,
            isHidden: src.isHidden,
            discovery: src.discovery,
          },
          visiblePublishRows.length,
        ),
      );
    }

    // Fire-and-forget: embed the rows we just wrote. Uses waitUntil so the
    // HTTP response returns immediately; embedding runs outside the request
    // path. Never fails the write — embedAndUpsertReleases catches every
    // error internally and logs to console.
    if (insertedIds.length > 0) {
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const embedConfig = await buildEmbedConfig(c.env);
            if (!embedConfig) return;
            // Load the rows back so we have full content, category, etc.
            // We need the org/product category for metadata filtering.
            const [orgRow] = src.orgId
              ? await db
                  .select({ category: organizations.category })
                  .from(organizations)
                  .where(eq(organizations.id, src.orgId))
              : [{ category: null as string | null }];
            // D1 bind-param cap is 100; chunk the IN clause so we stay
            // well clear of the limit even if the caller posts a large
            // batch. See `../lib/d1-limits.ts`.
            const rowsToEmbed: Array<{
              id: string;
              title: string;
              content: string;
              summary: string | null;
              version: string | null;
              publishedAt: string | null;
              sourceId: string;
              type: ReleaseType;
            }> = [];
            for (let i = 0; i < insertedIds.length; i += RELEASES_ID_IN_CHUNK_SIZE) {
              const slice = insertedIds.slice(i, i + RELEASES_ID_IN_CHUNK_SIZE);
              // oxlint-disable-next-line no-await-in-loop -- D1 chunked select (100 bind param limit for inArray)
              const rows = await db
                .select({
                  id: releases.id,
                  title: releases.title,
                  content: releases.content,
                  summary: releases.summary,
                  version: releases.version,
                  publishedAt: releases.publishedAt,
                  sourceId: releases.sourceId,
                  type: releases.type,
                })
                .from(releases)
                .where(inArray(releases.id, slice));
              rowsToEmbed.push(...rows);
            }

            const category = orgRow?.category ?? null;
            await embedAndUpsertReleases({
              // oxlint-disable-next-line no-map-spread -- copy-on-write required; r is a DB row
              releases: rowsToEmbed.map((r) => ({
                ...r,
                orgId: src.orgId,
                productId: src.productId,
                category,
              })),
              // See note in embedSourceSideEffect about the cast.
              vectorIndex: c.env
                .RELEASES_INDEX as unknown as import("@releases/search/vector-search.js").VectorizeIndex,
              embedConfig,
              onPersisted: async (ids) => {
                if (ids.length === 0) return;
                // Mark the rows as embedded. D1's 100 bind-param cap means
                // the embeddedAt SET + N IN-clause ids must total ≤100, so
                // we chunk IDs — see `../lib/d1-limits.ts`.
                const now = new Date().toISOString();
                for (let i = 0; i < ids.length; i += RELEASES_ID_IN_CHUNK_SIZE) {
                  const slice = ids.slice(i, i + RELEASES_ID_IN_CHUNK_SIZE);
                  // oxlint-disable-next-line no-await-in-loop -- D1 chunked update (100 bind param limit)
                  await db
                    .update(releases)
                    .set({ embeddedAt: now })
                    .where(inArray(releases.id, slice));
                }
              },
            });
          } catch (err) {
            logEvent("warn", {
              component: "sources-batch",
              event: "embed-side-effect-failed",
              err: err instanceof Error ? err : String(err),
            });
          }
        })(),
      );
    }

    return c.json({ inserted, total });
  } catch (err) {
    const classified = classifyDbError(err);
    logEvent("error", {
      component: "sources-batch",
      event: "insert-failed",
      sourceId: src.id,
      slug: src.slug,
      err: err instanceof Error ? err : String(err),
      ...(classified
        ? {
            causeCode: classified.code,
            causeMessage: classified.message,
            causeTransient: classified.transient,
          }
        : {}),
    });
    const message = (err as Error).message ?? "Failed to insert releases";
    return c.json(
      { error: "insert_failed", message, ...(classified ? { errorCode: classified.code } : {}) },
      500,
    );
  }
};
const postReleasesBatchRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Batch insert releases",
  description:
    "Inserts or upserts a batch of release rows for the source identified by slug or `src_…` ID on the bare path, or by org-scoped slug pair. Body: `{ releases: Array<{ title, content, version?, url?, contentHash?, publishedAt?, media?, type?, prerelease? }> }`. Body documented in prose — formal `requestBody` modelling is deferred to the validator-middleware phase of #894. On URL collision (`UNIQUE(source_id, url)`), content is backfilled when the incoming value is non-empty and the existing value is empty. LLM-generated placeholder versions (`<UNKNOWN>`, `n/a`) are stripped server-side. Release vectors are embedded asynchronously via `waitUntil`. Emits real-time events to the `ReleaseHub` Durable Object. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Batch result: inserted count and updated source total",
      content: { "application/json": { schema: resolver(BatchReleasesResponseSchema) } },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    500: {
      description: "D1 insert failed",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.post(
  "/sources/:slug/releases/batch",
  postReleasesBatchRoute,
  postReleasesBatchHandler,
);
sourceRoutes.post(
  "/orgs/:orgSlug/sources/:sourceSlug/releases/batch",
  postReleasesBatchRoute,
  postReleasesBatchHandler,
);

// ── Delete all releases for a source (for --force re-fetch) ──

const deleteSourceReleasesRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Delete all releases for a source",
  description:
    "Soft-deletes all releases for the source by default (`?hard` absent): sets `suppressed = true` with `suppressedReason = 'force_refetch'`. A subsequent fetch upserts new rows on top of suppressed ones, preserving AI-extracted summaries until replaced. Pass `?hard=true` for a hard delete that removes rows and purges Vectorize vectors. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Soft suppression count or hard delete count",
      content: { "application/json": { schema: resolver(DeleteSourceReleasesResponseSchema) } },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.delete("/sources/:slug/releases", deleteSourceReleasesRoute, async (c) => {
  const db = createDb(c.env.DB);
  const hard = c.req.query("hard") === "true";
  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  if (!hard) {
    // Soft path: flip rows to suppressed=1 with reason "force_refetch". Re-fetch
    // upserts hit ON CONFLICT(source_id, url) and overwrite the suppressed row,
    // backfilling content. This preserves AI-extracted summaries and embeddings
    // until the new fetch produces replacements (issue #666).
    const updated = await db
      .update(releases)
      .set({ suppressed: true, suppressedReason: "force_refetch" })
      .where(eq(releases.sourceId, src.id))
      .returning({ id: releases.id });
    return c.json({ suppressed: updated.length });
  }

  const deleted = await db.delete(releases).where(eq(releases.sourceId, src.id)).returning();

  // Clean up Vectorize vectors so they don't become orphans (#235).
  // Fire-and-forget via waitUntil — a Vectorize failure must not block the delete.
  const vectorIds = deleted.map((r) => r.id);
  if (vectorIds.length > 0 && c.env.RELEASES_INDEX) {
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const CHUNK = 500;
          for (let i = 0; i < vectorIds.length; i += CHUNK) {
            // oxlint-disable-next-line no-await-in-loop -- Vectorize chunked delete (API batch limit)
            await c.env.RELEASES_INDEX.deleteByIds(vectorIds.slice(i, i + CHUNK));
          }
        } catch (err) {
          logEvent("warn", {
            component: "sources",
            event: "vectorize-delete-failed",
            vectorCount: vectorIds.length,
            err: err instanceof Error ? err : String(err),
          });
        }
      })(),
    );
  }

  return c.json({ deleted: deleted.length, hard: true });
});

const postContentHashHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const peek = c.req.query("peek") === "true";
  // Validator middleware (registered alongside this handler) parsed the body.
  // Cast through the request because this standalone handler's type doesn't
  // carry the schema info.
  const body = (c.req as unknown as { valid: (target: "json") => { contentHash: string } }).valid(
    "json",
  );

  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const unchanged = src.lastContentHash === body.contentHash;
  if (unchanged) return c.json({ unchanged: true });

  if (!peek) {
    await db
      .update(sources)
      .set({ lastContentHash: body.contentHash })
      .where(eq(sources.id, src.id));
  }
  return c.json({ unchanged: false });
};
const postContentHashRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Check or update content hash",
  description:
    "Compares `contentHash` against the source's stored `lastContentHash`. Returns `{ unchanged: true }` when they match. When they differ, updates the stored hash (unless `?peek=true`) and returns `{ unchanged: false }`. Used by the fetch pipeline to skip unchanged scrape payloads without a full parse pass. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Hash comparison result",
      content: { "application/json": { schema: resolver(SourceContentHashResponseSchema) } },
    },
    400: {
      description: "Malformed JSON body or missing/wrong-typed contentHash field",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.post(
  "/sources/:slug/content-hash",
  postContentHashRoute,
  validateJson(SourceContentHashBodySchema),
  postContentHashHandler,
);
sourceRoutes.post(
  "/orgs/:orgSlug/sources/:sourceSlug/content-hash",
  postContentHashRoute,
  validateJson(SourceContentHashBodySchema),
  postContentHashHandler,
);

/**
 * Shallow-merge `patch` into `existing` (parsed from its stored JSON string).
 * Keys whose patch value is `null` are deleted. Invalid/non-object stored
 * metadata is treated as an empty object.
 */
export function mergeSourceMetadata(
  existing: string | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  let base: Record<string, unknown>;
  try {
    const parsed = JSON.parse(existing ?? "{}");
    base =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    base = {};
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  return merged;
}

// Atomic JSON-merge of the source metadata blob. Writers like the agent
// adapter need to update fields like `fetchEtag`/`fetchLastModified` without
// racing the cron poll (which also rewrites metadata via direct D1 access).
// Keys whose value is `null` are deleted from the stored metadata.
const patchMetadataHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);

  let patch: Record<string, unknown>;
  try {
    const parsed = await c.req.json<unknown>();
    if (!isJsonObject(parsed)) {
      return c.json({ error: "bad_request", message: "Body must be a JSON object" }, 400);
    }
    patch = parsed;
  } catch {
    return c.json({ error: "bad_request", message: "Body must be a JSON object" }, 400);
  }

  if (
    "changelogPaths" in patch &&
    Array.isArray(patch.changelogPaths) &&
    patch.changelogPaths.length > CHANGELOG_MAX_FILES
  ) {
    return c.json(
      {
        error: "bad_request",
        message: `changelogPaths length ${patch.changelogPaths.length} exceeds the cap of ${CHANGELOG_MAX_FILES}`,
      },
      400,
    );
  }

  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const merged = mergeSourceMetadata(src.metadata, patch);
  const serialized = JSON.stringify(merged);
  if (serialized !== (src.metadata ?? "{}")) {
    await db.update(sources).set({ metadata: serialized }).where(eq(sources.id, src.id));
  }
  return c.json({ metadata: merged });
};
const patchMetadataRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Merge source metadata",
  description:
    "Atomically JSON-merges the request body into the source's `metadata` blob. Keys whose value is `null` are deleted from the stored metadata; all other keys are shallow-merged (existing keys not in the patch are preserved). Accepts any JSON object — keys are freeform. If `changelogPaths` is present it must be an array and its length must not exceed the CHANGELOG_MAX_FILES cap. Body documented in prose — formal `requestBody` modelling is deferred to the validator-middleware phase of #894. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Merged metadata object",
      content: { "application/json": { schema: resolver(SourceMetadataResponseSchema) } },
    },
    400: {
      description: "Malformed JSON body or changelogPaths length exceeded",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.patch("/sources/:slug/metadata", patchMetadataRoute, patchMetadataHandler);
sourceRoutes.patch(
  "/orgs/:orgSlug/sources/:sourceSlug/metadata",
  patchMetadataRoute,
  patchMetadataHandler,
);

// ── Recent releases (for summary generation) ──

const getRecentReleasesHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const cutoffRaw = c.req.query("cutoff");

  if (!cutoffRaw) return c.json({ error: "cutoff query param required" }, 400);

  // Normalize the cutoff to a well-formed UTC ISO string before binding into
  // `gte(publishedAt, …)`. The publishedAt column stores UTC ISO strings, so
  // inputs like "2024/01/01" would parse as Date but compare lexically wrong.
  const cutoffDate = new Date(cutoffRaw);
  if (isNaN(cutoffDate.getTime())) {
    return c.json({ error: "bad_request", message: "cutoff must be a valid ISO-8601 date" }, 400);
  }
  const cutoff = cutoffDate.toISOString();

  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

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
};
const getRecentReleasesRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "List recent releases for a source",
  description:
    "Returns all non-suppressed releases for the source with `publishedAt` at or after `?cutoff=` (required, ISO-8601 date). Ordered by `publishedAt` descending. Used by the summarization agent to retrieve the release window it needs to summarize. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Recent release rows",
      content: { "application/json": { schema: resolver(SourceRecentReleasesResponseSchema) } },
    },
    400: {
      description: "Missing or invalid `cutoff` parameter",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.get(
  "/sources/:slug/recent-releases",
  getRecentReleasesRoute,
  getRecentReleasesHandler,
);
sourceRoutes.get(
  "/orgs/:orgSlug/sources/:sourceSlug/recent-releases",
  getRecentReleasesRoute,
  getRecentReleasesHandler,
);

// ── Known releases for incremental parsing ──

const KNOWN_RELEASES_MAX_LIMIT = 500;
const getKnownReleasesHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const rawLimit = parseInt(c.req.query("limit") ?? "10", 10);
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? rawLimit : 10, 1),
    KNOWN_RELEASES_MAX_LIMIT,
  );

  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

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
};
const getKnownReleasesRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "List known releases for a source",
  description:
    "Returns the N most-recent non-suppressed releases (default N=10, max 500) with only `version`, `title`, and `publishedAt` — the minimal set used by the incremental parsing agent to skip already-known versions. Accepts `?limit=N` (clamped to 1–500). Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Known release identifiers",
      content: { "application/json": { schema: resolver(SourceKnownReleasesResponseSchema) } },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.get("/sources/:slug/known-releases", getKnownReleasesRoute, getKnownReleasesHandler);
sourceRoutes.get(
  "/orgs/:orgSlug/sources/:sourceSlug/known-releases",
  getKnownReleasesRoute,
  getKnownReleasesHandler,
);

// ── Sessions involving a specific source slug ──

const getSourceSessionsRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Get active discovery sessions for a source",
  description:
    "Returns the active discovery session (if any) currently processing this source, queried from the `StatusHub` Durable Object. Returns `{ sessions: [] }` when no active session references this source. The session object shape is the live DO state blob and may evolve. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Active sessions for this source (empty array when none)",
      content: { "application/json": { schema: resolver(SourceSessionsResponseSchema) } },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.get("/sources/:slug/sessions", getSourceSessionsRoute, async (c) => {
  const db = createDb(c.env.DB);
  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const hub = getStatusHub(c.env);
  const res = await hub.fetch(new Request("https://do/active-sources"));
  const data = (await res.json()) as { slugs: string[]; sessionMap: Record<string, string> };
  const sessionId = data.sessionMap[src.slug];
  if (!sessionId) return c.json({ sessions: [] });

  const sessionRes = await hub.fetch(new Request(`https://do/sessions/${sessionId}`));
  if (sessionRes.status === 404) return c.json({ sessions: [] });
  const session = await sessionRes.json();
  return c.json({ sessions: [session] });
});

// Weekly release activity for source timeline visualization
const getSourceActivityHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);

  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

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

  // Default range: oldest to newest release
  let from = fromParam;
  let to = toParam;
  if (!from || !to) {
    const [bounds] = await db.all<{ oldest: string | null; newest: string | null }>(sql`
      SELECT MIN(r.published_at) AS oldest, MAX(r.published_at) AS newest
      FROM releases_visible r
      WHERE r.source_id = ${src.id}
        AND r.published_at IS NOT NULL
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
    if (org) {
      orgSlug = org.slug;
      orgName = org.name;
    }
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
};
const getSourceActivityRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Get source release activity",
  description:
    "Returns week-bucketed release counts for the source's full tracking lifetime (or the range selected by optional `?from=YYYY-MM-DD` and `?to=YYYY-MM-DD`). Returns 400 when either date is not in `YYYY-MM-DD` format or `from > to`. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Weekly release buckets for the source",
      content: { "application/json": { schema: resolver(SourceActivityResponseSchema) } },
    },
    400: {
      description: "Invalid or inconsistent date range",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.get("/sources/:slug/activity", getSourceActivityRoute, getSourceActivityHandler);
sourceRoutes.get(
  "/orgs/:orgSlug/sources/:sourceSlug/activity",
  getSourceActivityRoute,
  getSourceActivityHandler,
);

// Daily release heatmap for source contribution-graph visualization
const getSourceHeatmapHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);

  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const { from, to, toExclusive } = heatmapDateRange();
  const { rows, total } = await getSourceHeatmapData(db, src.id, from, toExclusive);

  return c.json({
    source: { slug: src.slug, name: src.name },
    range: { from, to },
    dailyCounts: rows.map((r) => ({ date: r.date, count: r.cnt })),
    total,
  });
};
const getSourceHeatmapRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Get source release heatmap",
  description:
    "Returns daily release counts for the trailing 365 days — contribution-graph visualization for the source detail page. Range is fixed server-side (trailing year); no query params. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Daily release counts for the trailing year",
      content: { "application/json": { schema: resolver(SourceHeatmapResponseSchema) } },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.get("/sources/:slug/heatmap", getSourceHeatmapRoute, getSourceHeatmapHandler);
sourceRoutes.get(
  "/orgs/:orgSlug/sources/:sourceSlug/heatmap",
  getSourceHeatmapRoute,
  getSourceHeatmapHandler,
);

const getSourceChangelogHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);
  const allRows = await db
    .select()
    .from(sourceChangelogFiles)
    .where(eq(sourceChangelogFiles.sourceId, src.id))
    .orderBy(sourceChangelogFiles.path);
  if (allRows.length === 0) {
    return c.json({ error: "not_found", message: "Changelog file not found" }, 404);
  }

  const requestedPath = c.req.query("path") ?? null;
  const selected = selectChangelogFile(allRows, requestedPath);
  if (!selected) {
    return c.json(
      { error: "not_found", message: `Changelog file not found for path: ${requestedPath}` },
      404,
    );
  }

  const files = allRows.map((r) => ({
    path: r.path,
    filename: r.filename,
    url: r.url,
    bytes: r.bytes,
    fetchedAt: r.fetchedAt,
  }));

  return c.json(
    buildChangelogResponse(
      selected,
      {
        offset: c.req.query("offset") ?? null,
        limit: c.req.query("limit") ?? null,
        tokens: c.req.query("tokens") ?? null,
      },
      files,
    ),
  );
};
const getSourceChangelogRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Get source changelog",
  description:
    "Returns the source's tracked CHANGELOG.md (or the file selected by `?path=`). Range params: `?offset=`, `?limit=` (chars), `?tokens=` (cl100k_base budget). Always emits the full `files` index so clients can render a file picker.",
  responses: {
    200: {
      description: "Changelog slice with file index",
      content: { "application/json": { schema: resolver(SourceChangelogResponseSchema) } },
    },
    404: {
      description: "Source or changelog file not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.get("/sources/:slug/changelog", getSourceChangelogRoute, getSourceChangelogHandler);
sourceRoutes.get(
  "/orgs/:orgSlug/sources/:sourceSlug/changelog",
  getSourceChangelogRoute,
  getSourceChangelogHandler,
);

/**
 * Admin-only: list changelog file rows whose content length exceeds
 * `minBytes` (default 256KB — the live-encode cap in src/lib/tokens.ts).
 * Used by scripts/backfill-changelog-tokens.ts to find rows whose
 * cached `tokens` value is an estimate rather than an exact count.
 */
sourceRoutes.get(
  "/sources/changelog-files/oversized",
  authMiddleware,
  describeRoute({
    hide: hideInProduction,
    tags: ["Sources"],
    summary: "List oversized changelog files",
    description:
      "Returns changelog file rows whose content length exceeds `?minBytes=` (default 256 KB — the live-encode token-count cap). Each row includes `sourceId`, `sourceSlug`, `orgSlug`, `path`, `bytes`, and `tokens` so `scripts/backfill-changelog-tokens.ts` can PATCH via the org-scoped path without an extra resolution round-trip. Auth: Bearer token required (hard auth — not public-read gated).",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Oversized changelog file rows",
        content: {
          "application/json": { schema: resolver(OversizedChangelogFilesResponseSchema) },
        },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const minBytes = parseInt(c.req.query("minBytes") ?? String(256 * 1024), 10);
    // sourceId + orgSlug travel alongside the slug so the backfill script can
    // PATCH via the org-scoped path (#698) without an extra resolution hop.
    const rows = await db
      .select({
        sourceId: sources.id,
        sourceSlug: sources.slug,
        sourceName: sources.name,
        orgSlug: organizations.slug,
        path: sourceChangelogFiles.path,
        filename: sourceChangelogFiles.filename,
        bytes: sourceChangelogFiles.bytes,
        tokens: sourceChangelogFiles.tokens,
        fetchedAt: sourceChangelogFiles.fetchedAt,
      })
      .from(sourceChangelogFiles)
      .innerJoin(sources, eq(sources.id, sourceChangelogFiles.sourceId))
      .innerJoin(organizations, eq(organizations.id, sources.orgId))
      .where(sql`length(${sourceChangelogFiles.content}) > ${minBytes}`)
      .orderBy(organizations.slug, sources.slug, sourceChangelogFiles.path);
    return c.json(rows);
  },
);

/**
 * Admin-only: write an exact cached token count for a single changelog
 * file. Used by scripts/backfill-changelog-tokens.ts to replace the
 * chars/4 estimate on rows that exceed the live-encode cap. Targets the
 * file identified by `path` (defaults to the row selected by
 * `selectChangelogFile` when omitted).
 *
 * Registered at both the legacy `/sources/:slug` form and the org-scoped
 * form — `resolveSourceFromContext` picks the right resolver based on
 * which params Hono matched.
 */
const patchChangelogTokensHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  let body: { tokens: number; path?: string };
  try {
    const parsed = await c.req.json<unknown>();
    if (!isJsonObject(parsed)) {
      return c.json({ error: "bad_request", message: "Body must be a JSON object" }, 400);
    }
    body = parsed as { tokens: number; path?: string };
  } catch {
    return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);
  }
  if (typeof body.tokens !== "number" || !Number.isFinite(body.tokens) || body.tokens < 0) {
    return c.json(
      { error: "invalid_tokens", message: "tokens must be a non-negative number" },
      400,
    );
  }
  if (body.path !== undefined && typeof body.path !== "string") {
    return c.json({ error: "bad_request", message: "path must be a string when provided" }, 400);
  }

  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const allRows = await db
    .select()
    .from(sourceChangelogFiles)
    .where(eq(sourceChangelogFiles.sourceId, src.id))
    .orderBy(sourceChangelogFiles.path);
  if (allRows.length === 0) {
    return c.json({ error: "not_found", message: "Changelog file not found" }, 404);
  }
  const selected = selectChangelogFile(allRows, body.path ?? null);
  if (!selected) {
    return c.json(
      { error: "not_found", message: `Changelog file not found for path: ${body.path}` },
      404,
    );
  }
  const oldTokens = selected.tokens;
  const newTokens = Math.floor(body.tokens);
  await db
    .update(sourceChangelogFiles)
    .set({ tokens: newTokens })
    .where(eq(sourceChangelogFiles.id, selected.id));
  return c.json({ path: selected.path, oldTokens, tokens: newTokens });
};
const patchChangelogTokensRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Write exact token count for a changelog file",
  description:
    "Writes a cached exact token count for a single changelog file identified by `path` (optional — defaults to the file selected by `selectChangelogFile` when omitted). Used by `scripts/backfill-changelog-tokens.ts` to replace the `chars/4` estimate on rows that exceed the live-encode cap. Body: `{ tokens: number, path?: string }`. Body documented in prose — formal `requestBody` modelling is deferred to the validator-middleware phase of #894. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Updated token count with old/new values",
      content: { "application/json": { schema: resolver(ChangelogTokensResponseSchema) } },
    },
    400: {
      description: "Invalid `tokens` value or wrong-typed `path`",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Source or changelog file not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.patch(
  "/sources/:slug/changelog/tokens",
  patchChangelogTokensRoute,
  patchChangelogTokensHandler,
);
sourceRoutes.patch(
  "/orgs/:orgSlug/sources/:sourceSlug/changelog/tokens",
  patchChangelogTokensRoute,
  patchChangelogTokensHandler,
);

/**
 * Admin-only: dry-run the CHANGELOG path discovery for a GitHub source. Runs
 * the same planner used by the cron fetch path (root listing, every workspace
 * declaration we recognize, override resolution) and returns the resolved
 * path list without fetching bodies or writing to D1. Used by operators when
 * configuring `metadata.changelogPaths` to find candidate paths before
 * committing to an override.
 *
 * Pre-checks the repo via `GET /repos/:owner/:repo` so a transient
 * GitHub error (rate-limit, auth, 5xx) doesn't get reported to the operator
 * as `200 {paths: []}` — i.e. "no changelogs found" when really we couldn't
 * reach GitHub.
 */
const probeChangelogsHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  if (src.type !== "github") {
    return c.json(
      {
        error: "unsupported_source_type",
        message: `Changelog probe is only available for GitHub sources (got type: ${src.type})`,
      },
      400,
    );
  }

  const ownerRepo = parseOwnerRepo(src.url);
  if (!ownerRepo) {
    return c.json(
      { error: "bad_source_url", message: `Cannot parse owner/repo from URL: ${src.url}` },
      400,
    );
  }

  const token = (await getSecret(c.env.GITHUB_TOKEN)) ?? undefined;
  const headers = buildGitHubHeaders(token, RELEASES_BOT_UA);

  const repoStatus = await classifyRepoStatus(ownerRepo, headers.apiHeaders);
  if (repoStatus.kind !== "ok") {
    return c.json(repoStatus.body, repoStatus.status);
  }

  const planned = await discoverChangelogPaths(src, headers);
  return c.json({
    sourceId: src.id,
    sourceSlug: src.slug,
    url: src.url,
    paths: planned ?? [],
  });
};

/**
 * Distinguish the four states callers care about for a probe precheck:
 * - 404 → repo doesn't exist (probe responds 404)
 * - 401/403 → auth/permission failure (probe responds 502)
 * - 429 → rate-limited (probe responds 503)
 * - 5xx / network error → upstream issue (probe responds 502)
 *
 * Pre-existing planner code swallows all of these into "empty result"; the
 * probe surfaces them so an operator distinguishes "no CHANGELOG found" from
 * "we couldn't read this repo."
 */
async function classifyRepoStatus(
  ownerRepo: { owner: string; repo: string },
  apiHeaders: Record<string, string>,
): Promise<
  | { kind: "ok" }
  | { kind: "fail"; status: 404 | 502 | 503; body: { error: string; message: string } }
> {
  const { owner, repo } = ownerRepo;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: apiHeaders });
  } catch (err) {
    return {
      kind: "fail",
      status: 502,
      body: {
        error: "github_upstream_error",
        message: `GitHub network error: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  if (res.ok) return { kind: "ok" };
  if (res.status === 404) {
    return {
      kind: "fail",
      status: 404,
      body: { error: "repo_not_found", message: `${owner}/${repo} not found on GitHub` },
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      kind: "fail",
      status: 502,
      body: {
        error: "github_auth_error",
        message: `GitHub returned ${res.status} for ${owner}/${repo}`,
      },
    };
  }
  if (res.status === 429) {
    return {
      kind: "fail",
      status: 503,
      body: { error: "github_rate_limited", message: "GitHub rate limit exceeded" },
    };
  }
  return {
    kind: "fail",
    status: 502,
    body: {
      error: "github_upstream_error",
      message: `GitHub returned ${res.status} for ${owner}/${repo}`,
    },
  };
}
const probeChangelogsRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Probe changelog paths for a GitHub source",
  description:
    "Dry-runs the CHANGELOG path discovery logic for a GitHub source — same planner the cron fetch uses (root listing, workspace declarations, override resolution) — without fetching file bodies or writing to D1. Pre-checks `GET /repos/:owner/:repo` so a transient GitHub error (rate-limit, auth, 5xx) surfaces as 502/503 rather than an empty paths list. Only available for sources with `type = 'github'`. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Discovered changelog paths (empty array when none found)",
      content: { "application/json": { schema: resolver(ChangelogProbeResponseSchema) } },
    },
    400: {
      description: "Source type is not github, or URL cannot be parsed",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Source or GitHub repo not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    502: {
      description: "GitHub auth error or upstream 5xx",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    503: {
      description: "GitHub rate limit exceeded",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.post("/sources/:slug/changelog/probe", probeChangelogsRoute, probeChangelogsHandler);
sourceRoutes.post(
  "/orgs/:orgSlug/sources/:sourceSlug/changelog/probe",
  probeChangelogsRoute,
  probeChangelogsHandler,
);

// Registered at both `/sources/:slug` (id-or-slug, id preferred) and
// `/orgs/:orgSlug/sources/:sourceSlug` (org-scoped, both segments id-or-slug).
// `resolveSourceFromContext` picks the right resolver from the matched params.
const getSourceDetailHandler = async (c: import("hono").Context<Env>) => {
  const page = parseInt(c.req.query("page") ?? "1", 10);
  const pageSize = parseInt(c.req.query("pageSize") ?? "20", 10);
  const includeCoverage = parseBoolParam(c.req.query("include_coverage"));
  const includePrereleases = parseBoolParam(c.req.query("include_prereleases"));
  const db = createDb(c.env.DB);

  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const offset = (page - 1) * pageSize;
  const cutoff = daysAgoIso(30);
  const cutoff90d = daysAgoIso(90);
  const dateCol = sql`COALESCE(${releasesVisible.publishedAt}, ${releasesVisible.fetchedAt})`;
  // Shared filter so the paginated rows, totals, derived stats, and fallback
  // version lookup all see the same release set. Without this, hiding
  // prereleases from the rows but leaving them in the count produces
  // overcounted `totalPages` and stale derived metrics.
  const prereleaseVisibleWhere = includePrereleases
    ? undefined
    : sql`(${releasesVisible.prerelease} IS NULL OR ${releasesVisible.prerelease} = 0)`;

  // Fire all independent reads in parallel — one D1 roundtrip wave instead of ~7 sequential ones.
  const orgQuery = src.orgId
    ? db
        .select({
          id: organizations.id,
          slug: organizations.slug,
          name: organizations.name,
        })
        .from(organizations)
        .where(eq(organizations.id, src.orgId))
    : Promise.resolve([]);

  const productQuery = src.productId
    ? db
        .select({ slug: products.slug })
        .from(products)
        .where(eq(products.id, src.productId))
        .limit(1)
    : Promise.resolve([]);

  // On page > 1 we can't derive latestVersion/latestDate from the paginated rows, so issue it in the same wave.
  const latestByDateQuery =
    page === 1
      ? Promise.resolve([])
      : db
          .select({ version: releasesVisible.version, publishedAt: releasesVisible.publishedAt })
          .from(releasesVisible)
          .where(
            and(
              eq(releasesVisible.sourceId, src.id),
              sql`${releasesVisible.publishedAt} IS NOT NULL`,
              prereleaseVisibleWhere,
            ),
          )
          .orderBy(desc(releasesVisible.publishedAt))
          .limit(1);

  const [
    releaseRows,
    orgRows,
    productRows,
    metricsRows,
    earliestRows,
    summaryRows,
    changelogExistsRows,
    latestByDateRows,
  ] = await Promise.all([
    getSourceReleasesPaginated(db, src.id, pageSize, offset, {
      includeCoverage,
      includePrereleases,
    }),
    orgQuery,
    productQuery,
    db
      .select({
        total: count(),
        oldest: min(dateCol),
        recent: sql<number>`COUNT(CASE WHEN ${dateCol} >= ${cutoff} THEN 1 END)`,
        recent90d: sql<number>`COUNT(CASE WHEN ${dateCol} >= ${cutoff90d} THEN 1 END)`,
      })
      .from(releasesVisible)
      .where(and(eq(releasesVisible.sourceId, src.id), prereleaseVisibleWhere)),
    db
      .select({ date: min(releasesVisible.publishedAt) })
      .from(releasesVisible)
      .where(
        and(
          eq(releasesVisible.sourceId, src.id),
          sql`${releasesVisible.publishedAt} IS NOT NULL`,
          prereleaseVisibleWhere,
        ),
      ),
    db
      .select()
      .from(releaseSummaries)
      .where(eq(releaseSummaries.sourceId, src.id))
      .orderBy(desc(releaseSummaries.generatedAt)),
    db
      .select({ one: sql<number>`1` })
      .from(sourceChangelogFiles)
      .where(eq(sourceChangelogFiles.sourceId, src.id))
      .limit(1),
    latestByDateQuery,
  ]);

  const org = (orgRows[0] as { id: string; slug: string; name: string } | undefined) ?? null;
  const productSlug = (productRows[0] as { slug: string } | undefined)?.slug ?? null;
  const metrics = metricsRows[0];
  const earliest = earliestRows[0];
  const hasChangelogFile = changelogExistsRows.length > 0;

  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
  const releasesFormatted = releaseRows.map((r) => ({
    id: r.id,
    version: r.version,
    type: r.type,
    title: r.title,
    summary: r.summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
    titleGenerated: r.title_generated,
    titleShort: r.title_short,
    content: hydrateMediaUrls(r.content, mediaOrigin),
    publishedAt: r.published_at,
    fetchedAt: r.fetched_at,
    url: r.url,
    media: parseReleaseMedia(r.media, mediaOrigin),
    coverageCount: r.coverage_count,
  }));

  // Derive latest{Version,Date}. Page 1 uses already-fetched rows; page > 1 uses the parallel query above.
  // The legacy fallback (latest by fetched_at when no version-bearing published row exists) runs only if needed.
  let latestVersion: string | null = null;
  let latestDate: string | null = null;

  if (page === 1 && releaseRows.length > 0) {
    const latestPublished = releaseRows.find((r) => r.published_at !== null);
    if (latestPublished?.version) {
      latestVersion = latestPublished.version;
      latestDate = latestPublished.published_at;
    }
    if (!latestVersion) latestVersion = releaseRows[0].version ?? null;
    if (!latestDate && latestPublished) latestDate = latestPublished.published_at;
  } else if (page > 1) {
    const latest = (
      latestByDateRows as Array<{ version: string | null; publishedAt: string | null }>
    )[0];
    latestVersion = latest?.version ?? null;
    latestDate = latest?.publishedAt ?? null;
    if (!latestVersion) {
      const [fallback] = await db
        .select({ version: releasesVisible.version })
        .from(releasesVisible)
        .where(and(eq(releasesVisible.sourceId, src.id), prereleaseVisibleWhere))
        .orderBy(desc(releasesVisible.fetchedAt))
        .limit(1);
      latestVersion = fallback?.version ?? null;
    }
  }

  const releasesLast30Days = metrics.recent;
  const avgReleasesPerWeek = computeAvgPerWeek(metrics.recent90d, metrics.oldest);
  const totalItems = metrics.total;
  const totalPages = Math.ceil(totalItems / pageSize);

  const rollingSummaryRow = summaryRows.find((s) => s.type === "rolling");
  const monthlySummaryRows = summaryRows.filter((s) => s.type === "monthly");

  const parsedMeta = JSON.parse(src.metadata || "{}");

  const result = {
    id: src.id,
    slug: src.slug,
    name: src.name,
    type: src.type,
    url: src.url,
    orgId: src.orgId,
    productId: src.productId,
    productSlug,
    org,
    isPrimary: src.isPrimary ?? false,
    isHidden: Boolean(src.isHidden),
    discovery: src.discovery ?? "curated",
    metadata: src.metadata ?? "{}",
    releaseCount: totalItems,
    releasesLast30Days,
    avgReleasesPerWeek,
    latestVersion,
    latestDate,
    changelogUrl: parsedMeta.changelogUrl ?? null,
    hasChangelogFile,
    lastFetchedAt: src.lastFetchedAt,
    lastPolledAt: src.lastPolledAt,
    trackingSince: earliest?.date ?? metrics.oldest ?? src.createdAt,
    releases: releasesFormatted,
    pagination: {
      page,
      pageSize,
      returned: releasesFormatted.length,
      totalItems,
      totalPages,
      hasMore: page < totalPages,
    },
    summaries: {
      rolling: rollingSummaryRow
        ? {
            windowDays: rollingSummaryRow.windowDays,
            summary: rollingSummaryRow.summary,
            releaseCount: rollingSummaryRow.releaseCount,
            generatedAt: rollingSummaryRow.generatedAt,
          }
        : null,
      monthly: monthlySummaryRows.map((s) => ({
        year: s.year,
        month: s.month,
        summary: s.summary,
        releaseCount: s.releaseCount,
        generatedAt: s.generatedAt,
      })),
    },
  };

  if (wantsMarkdown(c)) {
    return markdownResponse(c, sourceToMarkdown(result as any));
  }

  return c.json(result);
};
const getSourceDetailRoute = describeRoute({
  tags: ["Sources"],
  summary: "Get source detail",
  description:
    "Resolves by slug or `src_…` ID on the bare path, or by org-scoped slug pair. Paginated `releases` array (`?page=`, `?pageSize=`); `?include_coverage=true` exposes coverage rows.",
  responses: {
    200: {
      description: "Source detail with paginated releases",
      content: {
        "application/json": { schema: resolver(SourceDetailSchema) },
        "text/markdown": { schema: { type: "string" } },
      },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.get("/sources/:slug", getSourceDetailRoute, getSourceDetailHandler);
sourceRoutes.get(
  "/orgs/:orgSlug/sources/:sourceSlug",
  getSourceDetailRoute,
  getSourceDetailHandler,
);

// Cursor-paginated source release feed with optional inline FTS filter (`q`),
// prerelease toggle, and coverage flag — companion to `/v1/orgs/:slug/releases`.
const getSourceReleasesFeedHandler = async (c: import("hono").Context<Env>) => {
  const cursorParam = c.req.query("cursor") ?? null;
  const limit = parseLimitParam(c.req.query("limit"), 20, 100);
  const includeCoverage = parseBoolParam(c.req.query("include_coverage"));
  const includePrereleases = parseBoolParam(c.req.query("include_prereleases"));
  const qRaw = c.req.query("q")?.trim() ?? "";
  const ftsMatch = qRaw ? toFtsPrefixMatchQuery(qRaw) : undefined;

  const db = createDb(c.env.DB);
  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const results = await getSourceReleasesFeed(
    c.env.DB,
    src.id,
    parseFeedCursor(cursorParam),
    limit + 1,
    { includeCoverage, includePrereleases, ftsMatch },
  );

  const hasMore = results.length > limit;
  const pageRows = hasMore ? results.slice(0, limit) : results;
  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    nextCursor = buildFeedCursor(pageRows[pageRows.length - 1]);
  }

  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
  const releasesFormatted = pageRows.map((r) => ({
    id: r.id,
    version: r.version,
    type: r.type,
    title: r.title,
    summary: r.summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
    titleGenerated: r.title_generated,
    titleShort: r.title_short,
    content: hydrateMediaUrls(r.content, mediaOrigin),
    publishedAt: r.published_at,
    fetchedAt: r.fetched_at,
    url: r.url,
    media: parseReleaseMedia(r.media, mediaOrigin),
    prerelease: r.prerelease === 1,
    coverageCount: r.coverage_count,
  }));

  return c.json({ releases: releasesFormatted, pagination: { nextCursor, limit } });
};

const getSourceReleasesFeedRoute = describeRoute({
  tags: ["Sources"],
  summary: "Source release feed",
  description:
    "Cursor-paginated release feed scoped to one source. Supports inline FTS filter via `?q=`, prerelease toggle (`?include_prereleases=`), and coverage flag (`?include_coverage=`). Cursor shape matches `/v1/orgs/:slug/releases`.",
  responses: {
    200: { description: "Releases page" },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.get(
  "/orgs/:orgSlug/sources/:sourceSlug/releases",
  getSourceReleasesFeedRoute,
  getSourceReleasesFeedHandler,
);
sourceRoutes.get(
  "/sources/:slug/releases",
  getSourceReleasesFeedRoute,
  getSourceReleasesFeedHandler,
);

sourceRoutes.post(
  "/sources",
  describeRoute({
    hide: hideInProduction,
    tags: ["Sources"],
    summary: "Create source",
    description:
      "Slug auto-suffixes on collision (up to 20 attempts). Response carries the row plus a resolved `org { id, slug, name }` block and `productSlug`.",
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: "Source created (with resolved org + product attribution)",
        content: { "application/json": { schema: resolver(SourceMutationResponseSchema) } },
      },
      400: {
        description: "Missing required fields, unresolved org, or product not in org",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      409: {
        description: "Slug conflict or reserved slug",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(CreateSourceBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const body = c.req.valid("json");

    const baseSlug = body.slug ?? toSlug(body.name);
    if (isReservedSlug(baseSlug, "nested")) {
      return c.json(
        {
          error: "slug_reserved",
          message: `Slug "${baseSlug}" is reserved and cannot be used for a source. Choose a different slug or rename the source.`,
          slug: baseSlug,
        },
        409,
      );
    }

    // The schema's `SourceTypeSchema` enum already rejects unknown source
    // types at the boundary, so the handler-side guard is gone.
    // Auto-detect feed type when metadata contains a feedUrl and no explicit type was provided
    let type: SourceType = body.type ?? "scrape";
    if (!body.type && body.metadata) {
      try {
        const meta = JSON.parse(body.metadata);
        if (meta.feedUrl) type = "feed";
      } catch {
        /* invalid metadata JSON — ignore */
      }
    }

    // org_id is required and must resolve to a real org. orgId wins over orgSlug
    // when both are supplied. Guard here until the Phase C NOT NULL migration lands.
    let orgId: string | null = null;
    const orgRef = body.orgId ?? body.orgSlug;
    if (orgRef) {
      const [org] = await db.select().from(organizations).where(orgWhere(orgRef));
      orgId = org?.id ?? null;
    }
    if (!orgId) {
      return c.json(
        {
          error: "bad_request",
          message: "orgId or orgSlug is required (must resolve to an existing org)",
        },
        400,
      );
    }

    // Resolve productId. `productId` wins over `productSlug` when both
    // supplied. Pre-#794 this endpoint silently ignored a `productId` body
    // field — agents that passed `--product chrome` got back a source with
    // no product attached. Both branches enforce `products.orgId === orgId`
    // so a typed `prod_…` from a different org can't smuggle a cross-org
    // pairing past the resolution step.
    let productId: string | null = null;
    if (body.productId) {
      const [product] = await db
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.id, body.productId),
            eq(products.orgId, orgId),
            isNull(products.deletedAt),
          ),
        )
        .limit(1);
      if (!product) {
        return c.json(
          { error: "bad_request", message: `productId "${body.productId}" not found in this org` },
          400,
        );
      }
      productId = product.id;
    } else if (body.productSlug) {
      const idMatch = isProductId(body.productSlug)
        ? eq(products.id, body.productSlug)
        : eq(products.slug, body.productSlug);
      const [product] = await db
        .select({ id: products.id })
        .from(products)
        .where(and(idMatch, eq(products.orgId, orgId), isNull(products.deletedAt)))
        .limit(1);
      if (!product) {
        return c.json(
          {
            error: "bad_request",
            message: `productSlug "${body.productSlug}" not found in this org`,
          },
          400,
        );
      }
      productId = product.id;
    }

    // Insert with auto-suffix on slug collision: try base, then base-2 … base-20.
    // Loop-with-catch is race-safe: no TOCTOU gap between check and insert.
    const MAX_SLUG_ATTEMPTS = 20;
    const createdAt = new Date().toISOString();
    const insertValues = (slug: string) => ({
      name: body.name,
      slug,
      type,
      url: body.url,
      orgId,
      ...(productId && { productId }),
      metadata: body.metadata ?? "{}",
      createdAt,
      ...(body.isPrimary !== undefined && { isPrimary: body.isPrimary }),
    });

    let source: typeof sources.$inferSelect | undefined;

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential retry loop: each attempt depends on the previous collision
        const [row] = await db.insert(sources).values(insertValues(slug)).returning();
        source = row;
        break;
      } catch (err) {
        if (isConflictError(err)) {
          continue;
        }
        throw err;
      }
    }

    if (!source) {
      // All 20 slug attempts collided — fall back to the original 409 path.
      return c.json(
        {
          error: "conflict",
          message: `Source with slug "${baseSlug}" already exists (exhausted ${MAX_SLUG_ATTEMPTS} suffix attempts)`,
        },
        409,
      );
    }

    // Onboarding tail. `X-Onboard-Mode: manual` skips the workflow's backfill
    // step; the inline fallback path has no backfill to skip (CLI calls
    // `/sources/:slug/fetch` separately).
    const inlineFallback = () => {
      if (orgId) c.executionCtx.waitUntil(regeneratePlaybook(db, orgId));
      c.executionCtx.waitUntil(embedSourceSideEffect(c.env, db, source.id));
    };

    if (c.env.ONBOARD_USE_WORKFLOW === "true" && c.env.ONBOARD_SOURCE_WORKFLOW) {
      const skipBackfill = c.req.header("x-onboard-mode") === "manual";
      const workflow = c.env.ONBOARD_SOURCE_WORKFLOW;
      // Fire-and-forget: control-plane RPC must not block the response.
      // Deterministic id makes a transient retry safe (CF rejects duplicates).
      c.executionCtx.waitUntil(
        workflow
          .create({
            id: `onboard-source-${source.id}`,
            params: { sourceId: source.id, skipBackfill },
          })
          .catch((err) => {
            logEvent("warn", {
              component: "sources",
              event: "onboard-workflow-dispatch-failed",
              err: err instanceof Error ? err : String(err),
            });
            inlineFallback();
          }),
      );
    } else {
      inlineFallback();
    }

    const enriched = await attachSourceAttribution(db, source);
    return c.json(enriched, 201);
  },
);

const patchSourceHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<SourcePatchInput>();

  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const UPDATABLE_FIELDS = [
    "name",
    "url",
    "type",
    "slug",
    "metadata",
    "orgId",
    "productId",
    "lastFetchedAt",
    "lastContentHash",
    "fetchPriority",
    "consecutiveNoChange",
    "consecutiveErrors",
    "nextFetchAfter",
    "isPrimary",
    "isHidden",
    "changeDetectedAt",
    "lastPolledAt",
  ] as const;

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.url !== undefined) updates.url = body.url;
  if (body.type !== undefined) updates.type = body.type;
  if (body.slug !== undefined) updates.slug = body.slug;
  if (body.metadata !== undefined) updates.metadata = body.metadata;
  if (body.orgId !== undefined) updates.orgId = body.orgId;
  if (body.productId !== undefined) updates.productId = body.productId;

  // Mirror the cross-org guard from POST /v1/sources (#794 review): the
  // PATCH path must not let a `prod_…` from a different org attach to
  // this source. Resolve against the post-update orgId so a single
  // PATCH that re-orgs *and* sets a product is checked against the new
  // org, not the old one. `productId: null` (clearing) skips the check.
  if (typeof body.productId === "string" && body.productId.length > 0) {
    const effectiveOrgId =
      typeof body.orgId === "string" && body.orgId.length > 0 ? body.orgId : src.orgId;
    if (!effectiveOrgId) {
      return c.json(
        {
          error: "bad_request",
          message: `Cannot set productId on a source with no org. Set orgId in the same patch.`,
        },
        400,
      );
    }
    const [product] = await db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.id, body.productId),
          eq(products.orgId, effectiveOrgId),
          isNull(products.deletedAt),
        ),
      )
      .limit(1);
    if (!product) {
      return c.json(
        {
          error: "bad_request",
          message: `productId "${body.productId}" not found in this org`,
        },
        400,
      );
    }
  }
  if (body.lastFetchedAt !== undefined) updates.lastFetchedAt = body.lastFetchedAt;
  if (body.lastContentHash !== undefined) updates.lastContentHash = body.lastContentHash;
  if (body.fetchPriority !== undefined) updates.fetchPriority = body.fetchPriority;
  if (body.consecutiveNoChange !== undefined)
    updates.consecutiveNoChange = body.consecutiveNoChange;
  if (body.consecutiveErrors !== undefined) updates.consecutiveErrors = body.consecutiveErrors;
  if (body.nextFetchAfter !== undefined) updates.nextFetchAfter = body.nextFetchAfter;
  if (body.isPrimary !== undefined) updates.isPrimary = body.isPrimary;
  if (body.isHidden !== undefined) updates.isHidden = body.isHidden;
  if (body.changeDetectedAt !== undefined) updates.changeDetectedAt = body.changeDetectedAt;
  if (body.lastPolledAt !== undefined) updates.lastPolledAt = body.lastPolledAt;

  if (Object.keys(updates).length === 0) {
    const bodyKeys = Object.keys(body);
    const unrecognized = bodyKeys.filter(
      (k) => !(UPDATABLE_FIELDS as readonly string[]).includes(k),
    );
    const message =
      unrecognized.length > 0
        ? `Unrecognized fields: ${unrecognized.join(", ")}. Updatable fields: ${UPDATABLE_FIELDS.join(", ")}`
        : `No values to set. Updatable fields: ${UPDATABLE_FIELDS.join(", ")}`;
    return c.json({ error: "bad_request", message }, 400);
  }

  // Check for slug uniqueness before attempting update
  if (body.slug !== undefined && body.slug !== src.slug) {
    if (isReservedSlug(body.slug, "nested")) {
      return c.json(
        {
          error: "slug_reserved",
          message: `Slug "${body.slug}" is reserved and cannot be used for a source.`,
          slug: body.slug,
        },
        409,
      );
    }
    const [existing] = await db.select().from(sources).where(eq(sources.slug, body.slug));
    if (existing) {
      return c.json(
        { error: "conflict", message: `Source with slug "${body.slug}" already exists` },
        409,
      );
    }
  }

  const [updated] = await db.update(sources).set(updates).where(eq(sources.id, src.id)).returning();
  if (src.orgId) c.executionCtx.waitUntil(regeneratePlaybook(db, src.orgId));
  // Only re-embed if semantically-relevant fields changed. Metadata churn
  // (lastPolledAt, consecutiveErrors, etc.) would otherwise trigger a
  // needless embedding API call on every poll.
  const semanticChanged = body.name !== undefined || body.url !== undefined;
  if (semanticChanged) {
    c.executionCtx.waitUntil(embedSourceSideEffect(c.env, db, src.id));
  }
  const enriched = await attachSourceAttribution(db, updated);
  return c.json(enriched);
};
const patchSourceRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Update source",
  description:
    "All body fields optional. Re-embeds the source in Vectorize when `name` or `url` changes; cron/poll fields (`lastFetchedAt`, `consecutiveErrors`, …) skip re-embed. Slug uniqueness is checked before write. Response carries the row plus a resolved `org { id, slug, name }` block and `productSlug`.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Source updated (with resolved org + product attribution)",
      content: { "application/json": { schema: resolver(SourceMutationResponseSchema) } },
    },
    400: {
      description: "No updatable fields supplied or unrecognized fields",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    409: {
      description: "Slug conflict or reserved slug",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.patch("/sources/:slug", patchSourceRoute, patchSourceHandler);
sourceRoutes.patch("/orgs/:orgSlug/sources/:sourceSlug", patchSourceRoute, patchSourceHandler);

const deleteSourceRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Delete a source",
  description:
    "Soft-deletes the source by default: sets `deletedAt` and mangles the slug to `<slug>--<id>` so the original slug can be reused. Releases stay attached for the cleanup cron's FK cascade. Pass `?hard=true` for a hard delete that also purges the row (tombstones are reachable by typed `src_…` ID when `?hard=true`). Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required. Bare-path slugs (non-ID) return 400 `bare_slug_rejected` per #698 — use the org-scoped variant or pass a `src_…` ID.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Soft deletion timestamp or hard delete confirmation",
      content: { "application/json": { schema: resolver(DeleteSourceResponseSchema) } },
    },
    400: {
      description: "Bare slug rejected on the bare path (use org-scoped path or typed ID)",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.delete("/sources/:slug", deleteSourceRoute, async (c) => {
  const db = createDb(c.env.DB);
  const hard = c.req.query("hard") === "true";

  // includeDeleted lets hard-delete reach tombstones for purge. Tombstones
  // rename their slug to "<slug>--<id>" so a normal slug-path lookup wouldn't
  // collide with a live row; passing a `src_` ID is the canonical way to
  // reach a tombstone.
  const src = await resolveSourceFromContext(c, db, { includeDeleted: hard });
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const orgId = src.orgId;

  if (hard) {
    await db.delete(sources).where(eq(sources.id, src.id));
    if (orgId) c.executionCtx.waitUntil(regeneratePlaybook(db, orgId));
    return c.json({ deleted: true, hard: true });
  }

  // Soft delete: tombstone the source. Slug is mangled so the inline UNIQUE
  // doesn't block a re-onboard under the original slug. Releases stay
  // attached so the cleanup cron can hard-purge via the existing FK cascade.
  const now = new Date().toISOString();
  await db
    .update(sources)
    .set({ deletedAt: now, slug: `${src.slug}--${src.id}` })
    .where(eq(sources.id, src.id));
  if (orgId) c.executionCtx.waitUntil(regeneratePlaybook(db, orgId));
  return c.json({ deleted: true, deletedAt: now });
});

// Bulk release insert for data seeding
const postReleaseRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Insert a single release",
  description:
    "Inserts a single release for the source. Unlike the `/batch` endpoint this path is used for data seeding or manual inserts where the caller controls the `id`. On `UNIQUE(source_id, url)` conflict the insert is skipped (`onConflictDoNothing`) and the response is `{ skipped: true }` (200). A successful insert returns 201 with the inserted row. LLM-generated version placeholders (`<UNKNOWN>`, `n/a`) are stripped. Body fields: `title`, `content` (required); `id?`, `version?`, `summary?`, `titleGenerated?`, `titleShort?`, `url?`, `contentHash?`, `publishedAt?`, `fetchedAt?`, `type?`. Body documented in prose — formal `requestBody` modelling is deferred to the validator-middleware phase of #894. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required. Bare-path slugs return 400 `bare_slug_rejected` per #698 — pass a `src_…` ID on the bare path.",
  security: [{ bearerAuth: [] }],
  responses: {
    201: {
      description: "Release inserted",
      content: { "application/json": { schema: resolver(InsertReleaseResponseSchema) } },
    },
    200: {
      description: "Insert skipped (URL conflict)",
      content: { "application/json": { schema: resolver(InsertReleaseResponseSchema) } },
    },
    400: {
      description: "Bare slug rejected on the bare path (use typed ID)",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Source not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    500: {
      description: "Insert failed",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
sourceRoutes.post("/sources/:slug/releases", postReleaseRoute, async (c) => {
  const db = createDb(c.env.DB);

  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  let body: {
    id?: string;
    version?: string;
    title: string;
    content: string;
    /** AI-generated summary (#860). */
    summary?: string;
    /** AI-generated headline (#860). */
    titleGenerated?: string;
    /** AI-generated smart-brevity headline (#860). */
    titleShort?: string;
    url?: string;
    contentHash?: string;
    metadata?: string;
    publishedAt?: string;
    fetchedAt?: string;
    type?: ReleaseType;
  };
  try {
    const parsed = await c.req.json<unknown>();
    if (!isJsonObject(parsed)) {
      return c.json({ error: "bad_request", message: "Body must be a JSON object" }, 400);
    }
    body = parsed as typeof body;
  } catch {
    return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);
  }
  if (typeof body.title !== "string" || body.title.length === 0) {
    return c.json({ error: "bad_request", message: "title must be a non-empty string" }, 400);
  }
  if (typeof body.content !== "string") {
    return c.json({ error: "bad_request", message: "content must be a string" }, 400);
  }

  // See batch handler: strip LLM placeholders ("<UNKNOWN>", "n/a") so
  // they don't leak into the version slot the web UI promotes. Type-guard
  // the JSON value before .trim() so non-string payloads are safely coerced
  // to null instead of throwing.
  const version = typeof body.version === "string" ? (sanitizeVersion(body.version) ?? null) : null;

  const size = computeContentSize(body.content);
  try {
    const [release] = await db
      .insert(releases)
      .values({
        id: body.id,
        sourceId: src.id,
        version,
        versionSort: computeVersionSort(version),
        type: body.type ?? "feature",
        title: body.title,
        content: body.content,
        summary: body.summary ?? null,
        titleGenerated: body.titleGenerated ?? null,
        titleShort: body.titleShort ?? null,
        url: body.url ?? null,
        contentHash: body.contentHash ?? null,
        contentChars: size.contentChars,
        contentTokens: size.contentTokens,
        metadata: body.metadata ?? "{}",
        publishedAt: body.publishedAt ?? inferMonthOnlyDate(body.title) ?? null,
        prerelease: isPrereleaseVersion(version),
        fetchedAt: body.fetchedAt ?? new Date().toISOString(),
      })
      .onConflictDoNothing()
      .returning();
    return c.json(release ?? { skipped: true }, release ? 201 : 200);
  } catch (err) {
    const classified = classifyDbError(err);
    return c.json(
      {
        error: "insert_failed",
        message: "Failed to insert release",
        ...(classified ? { errorCode: classified.code } : {}),
      },
      500,
    );
  }
});

// ── Release CRUD ──

sourceRoutes.get(
  "/releases/:id",
  describeRoute({
    tags: ["Releases"],
    summary: "Get release by ID",
    description:
      "Returns a single release by its typed `rel_…` ID. Suppressed and coverage-side rows are excluded via the `releases_visible` view — they return 404. The `content` field has CDN-origin media URLs rewritten in-place; the `media` array is parsed from the raw D1 JSON. Accepts `Accept: text/markdown` to receive the release formatted as Markdown.",
    responses: {
      200: {
        description: "Release detail",
        content: { "application/json": { schema: resolver(ReleaseDetailResponseSchema) } },
      },
      404: {
        description: "Release not found (or suppressed / coverage-only)",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const id = c.req.param("id");

    const rows = await db
      .select({
        release: releases,
        sourceName: sourcesActive.name,
        sourceSlug: sourcesActive.slug,
        sourceType: sourcesActive.type,
        orgSlug: organizationsActive.slug,
        orgName: organizationsActive.name,
      })
      .from(releases)
      .innerJoin(sourcesActive, eq(releases.sourceId, sourcesActive.id))
      .leftJoin(organizationsActive, eq(sourcesActive.orgId, organizationsActive.id))
      .where(and(eq(releases.id, id), sql`${releases.id} IN (SELECT id FROM releases_visible)`));

    if (rows.length === 0) return c.json({ error: "not_found", message: "Release not found" }, 404);

    const { release, sourceName, sourceSlug, sourceType, orgSlug, orgName } = rows[0];
    const org = orgSlug && orgName ? { slug: orgSlug, name: orgName } : null;
    const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";

    const media = parseReleaseMedia(release.media as string | null, mediaOrigin);
    const composition = parseCompositionFromMetadata(release.metadata as string | null);

    // Strip the raw `metadata` blob from the spread — it's not in
    // ReleaseDetailResponseSchema and would leak internal storage shape (and,
    // post-composition extraction, would duplicate `composition` as a raw
    // JSON string).
    const { metadata: _metadata, ...releaseRest } = release;
    const hydratedContent = hydrateMediaUrls(release.content as string, mediaOrigin);
    const result = {
      ...releaseRest,
      content: hydratedContent,
      media,
      sourceName,
      sourceSlug,
      sourceType,
      org,
      composition,
    };

    if (wantsMarkdown(c)) {
      return markdownResponse(c, releaseToMarkdown(result as any));
    }

    return c.json(result);
  },
);

sourceRoutes.delete(
  "/releases/:id",
  describeRoute({
    hide: hideInProduction,
    tags: ["Releases"],
    summary: "Delete a release",
    description:
      "Hard-deletes the release row. This is a destructive operation — prefer suppression (`POST /v1/releases/:id/suppress`) to hide a release from read paths without losing the row.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Release deleted",
        content: { "application/json": { schema: resolver(ReleaseDeleteResponseSchema) } },
      },
      404: {
        description: "Release not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const id = c.req.param("id");

    const deleted = await db
      .delete(releases)
      .where(eq(releases.id, id))
      .returning({ id: releases.id });
    if (deleted.length === 0)
      return c.json({ error: "not_found", message: "Release not found" }, 404);

    return c.json({ deleted: true });
  },
);

sourceRoutes.patch(
  "/releases/:id",
  describeRoute({
    hide: hideInProduction,
    tags: ["Releases"],
    summary: "Update a release",
    description:
      "Partially updates a release. All body fields are optional — only supplied fields are written. Required-non-null columns (`title`, `content`) must be strings when present; the nullable string columns (`version`, `url`, `publishedAt`, `contentHash`) accept a string or `null`. The three AI-generated fields (`summary`, `titleGenerated`, `titleShort`) accept `null` to explicitly clear the stored value. The `composition` field accepts a `{bugs, features, enhancements}` object to replace the stored counts, or `null` to clear them — neighbouring keys in `metadata` are preserved (JSON-merged via `json_set` / `json_remove`). Non-whitelisted fields are rejected by the schema's `.strict()` mode; a body whose sanitized whitelist is empty after `version` normalization also returns `400`. When any of `content`, `title`, `summary`, `titleGenerated`, or `titleShort` is updated the release vector is re-embedded asynchronously. Response is the raw release row (no joined source / org metadata, no parsed `media`) — re-fetch via `GET /v1/releases/:id` for the augmented shape.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Updated release (raw row)",
        content: { "application/json": { schema: resolver(ReleasePatchResponseSchema) } },
      },
      400: {
        description: "Malformed JSON body, unknown / wrong-typed field, or empty update set",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Release not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(UpdateReleaseBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const id = c.req.param("id");
    const body = c.req.valid("json");

    // The schema is `.strict()` and enforces per-field types; this loop just
    // copies the supplied fields into `updates` and runs the `version`
    // sanitization that the schema can't express. Empty updates still 400.
    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates.title = body.title;
    if (body.content !== undefined) {
      updates.content = body.content;
      const size = computeContentSize(body.content);
      updates.contentChars = size.contentChars;
      updates.contentTokens = size.contentTokens;
    }
    if (body.url !== undefined) updates.url = body.url;
    if (body.publishedAt !== undefined) updates.publishedAt = body.publishedAt;
    if (body.contentHash !== undefined) updates.contentHash = body.contentHash;
    if (body.summary !== undefined) updates.summary = body.summary;
    if (body.titleGenerated !== undefined) updates.titleGenerated = body.titleGenerated;
    if (body.titleShort !== undefined) updates.titleShort = body.titleShort;
    if (body.composition !== undefined) {
      // null clears $.composition; an object replaces it. Either way the
      // helper hands back a json_set / json_remove fragment that leaves the
      // rest of metadata untouched.
      updates.metadata = buildCompositionMetadataSet(body.composition);
    }
    if (body.version !== undefined) {
      // sanitizeVersion trims and may coerce empty/whitespace to null; mirror
      // the historical behavior of clearing the column on a falsy input.
      updates.version =
        typeof body.version === "string" ? (sanitizeVersion(body.version) ?? null) : null;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "bad_request", message: "No writable fields supplied" }, 400);
    }

    // Join sources so we have the source row available for the re-embed side
    // effect without a second round-trip after the update.
    const [row] = await db
      .select({ release: releases, source: sources })
      .from(releases)
      .innerJoin(sources, eq(sources.id, releases.sourceId))
      .where(eq(releases.id, id));
    if (!row) return c.json({ error: "not_found", message: "Release not found" }, 404);

    const [updated] = await db.update(releases).set(updates).where(eq(releases.id, id)).returning();
    if (!updated) return c.json({ error: "not_found", message: "Release not found" }, 404);

    // Re-embed when any field that feeds the embedding text changes. Metadata-
    // only edits (version, url, publishedAt, contentHash) do not affect the
    // vector and are skipped to avoid wasting Voyage budget.
    const embeddingRelevant =
      body.content !== undefined ||
      body.title !== undefined ||
      body.summary !== undefined ||
      body.titleGenerated !== undefined ||
      body.titleShort !== undefined;

    if (embeddingRelevant) {
      logEvent("info", {
        component: "patch-release",
        event: "reembed-triggered",
        releaseId: id,
        sourceId: row.source.id,
      });
      const githubToken = (await getSecret(c.env.GITHUB_TOKEN).catch(() => null)) ?? undefined;
      c.executionCtx.waitUntil(
        embedReleasesForSource(
          db,
          row.source,
          [id],
          { ...c.env, GITHUB_TOKEN: githubToken },
          { throwOnError: false },
        ),
      );
    }

    return c.json(updated);
  },
);

// ── Release suppression ──

sourceRoutes.post(
  "/releases/:id/suppress",
  describeRoute({
    hide: hideInProduction,
    tags: ["Releases"],
    summary: "Suppress a release",
    description:
      "Marks the release as suppressed (`suppressed = true`), hiding it from all public read paths without hard-deleting the row. The optional `reason` field is stored in `suppressed_reason` for audit purposes.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Release suppressed",
        content: { "application/json": { schema: resolver(ReleaseSuppressResponseSchema) } },
      },
      404: {
        description: "Release not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(ReleaseSuppressBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const [updated] = await db
      .update(releases)
      .set({ suppressed: true, suppressedReason: body.reason ?? null })
      .where(eq(releases.id, id))
      .returning({ id: releases.id, sourceId: releases.sourceId });

    if (!updated) return c.json({ error: "not_found", message: "Release not found" }, 404);

    // A row that was visible a moment ago is now hidden — purge the homepage
    // reel caches so users don't click a stale card into a 404.
    c.executionCtx.waitUntil(
      invalidateLatestCache(c.env, { nReleases: 1, sourceId: updated.sourceId }),
    );

    return c.json({ suppressed: true });
  },
);

sourceRoutes.post(
  "/releases/:id/unsuppress",
  describeRoute({
    hide: hideInProduction,
    tags: ["Releases"],
    summary: "Unsuppress a release",
    description:
      "Clears the suppression flag (`suppressed = false`) and nulls out `suppressed_reason`, making the release visible on all read paths again.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Release unsuppressed",
        content: { "application/json": { schema: resolver(ReleaseUnsuppressResponseSchema) } },
      },
      404: {
        description: "Release not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const id = c.req.param("id");

    const [updated] = await db
      .update(releases)
      .set({
        suppressed: false,
        suppressedReason: null,
      })
      .where(eq(releases.id, id))
      .returning({ id: releases.id, sourceId: releases.sourceId });

    if (!updated) return c.json({ error: "not_found", message: "Release not found" }, 404);

    // Newly-visible row should appear in the reel without waiting out the TTL.
    c.executionCtx.waitUntil(
      invalidateLatestCache(c.env, { nReleases: 1, sourceId: updated.sourceId }),
    );

    return c.json({ unsuppressed: true });
  },
);

// ── Embed side effect helpers ──
//
// These load the fresh row from D1 and push its vector to ENTITIES_INDEX.
// Called via c.executionCtx.waitUntil so the HTTP response never blocks on
// embedding. Embedding failure never fails the write.

export async function embedSourceSideEffect(
  env: Env["Bindings"],
  db: ReturnType<typeof createDb>,
  sourceId: string,
  opts?: { throwOnError?: boolean },
): Promise<void> {
  try {
    const embedConfig = await buildEmbedConfig(env);
    if (!embedConfig) return;
    // Symmetric to the embedConfig guard. Staging deliberately ships without
    // Vectorize bindings, so a manual `wrangler workflows trigger` would
    // otherwise hit `undefined.upsert(...)` and propagate via throwOnError.
    if (!env.ENTITIES_INDEX) return;
    const [src] = await db.select().from(sources).where(eq(sources.id, sourceId));
    if (!src) return;
    // Derive a best-effort domain from the URL.
    let domain: string | null = null;
    try {
      domain = new URL(src.url).hostname;
    } catch {
      domain = null;
    }
    // Inherit category from the parent org for retrieval filtering.
    let category: string | null = null;
    if (src.orgId) {
      const [org] = await db
        .select({ category: organizations.category })
        .from(organizations)
        .where(eq(organizations.id, src.orgId));
      category = org?.category ?? null;
    }
    await embedAndUpsertEntities({
      entities: [
        {
          id: src.id,
          kind: "source" as EntityKind,
          name: src.name,
          description: null,
          category,
          domain,
          orgId: src.orgId ?? null,
        },
      ],
      // Cast required: workers-types `VectorizeIndex` declares a narrower
      // metadata value type than the runtime-agnostic interface in
      // `packages/search/src/vector-search.ts`. Assignable at runtime, diverges by
      // variance in the type system.
      vectorIndex:
        env.ENTITIES_INDEX as unknown as import("@releases/search/vector-search.js").VectorizeIndex,
      embedConfig,
      onPersisted: async () => {
        await db
          .update(sources)
          .set({ embeddedAt: new Date().toISOString() })
          .where(eq(sources.id, src.id));
      },
      throwOnError: opts?.throwOnError,
    });
  } catch (err) {
    if (opts?.throwOnError) throw err;
    logEvent("warn", {
      component: "sources",
      event: "embed-side-effect-failed",
      err: err instanceof Error ? err : String(err),
    });
  }
}
