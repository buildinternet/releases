import { Hono } from "hono";
import {
  eq,
  desc,
  count,
  and,
  or,
  like,
  min,
  isNull,
  isNotNull,
  sql,
  gte,
  inArray,
} from "drizzle-orm";
import { createDb } from "../db.js";
import {
  sources,
  releases,
  organizations,
  releaseSummaries,
  products,
  sourceChangelogFiles,
  type ReleaseType,
} from "@buildinternet/releases-core/schema";
import type { Pagination } from "@buildinternet/releases-core/cli-contracts";
import { RELEASE_URL_UPSERT } from "@releases/core-internal/release-upsert";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { toSlug } from "@buildinternet/releases-core/slug";
import { isReservedSlug } from "@buildinternet/releases-core/reserved-slugs";
import {
  buildChangelogResponse,
  selectChangelogFile,
} from "@buildinternet/releases-core/changelog-slice";
import type { SourceWithOrg, SourcePatchInput } from "@buildinternet/releases-api-types";
import {
  getStatusHub,
  sourceWhere,
  orgWhere,
  productWhere,
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
import { fetchOne } from "../cron/poll-fetch.js";
import { getSourceMeta } from "@releases/adapters/feed.js";
import type { Env } from "../index.js";
import {
  getSourcesWithStats,
  countSourcesForList,
  getSourceReleasesPaginated,
  getSourceActivityBuckets,
  getSourceHeatmapData,
  SOURCE_SORT_FIELDS,
} from "../queries/sources.js";
import { notDisabled } from "../queries/shared.js";
import { regeneratePlaybook } from "../playbook-regen.js";
import { embedAndUpsertReleases } from "@releases/search/embed-releases.js";
import { embedAndUpsertEntities, type EntityKind } from "@releases/search/embed-entities.js";
import { publishReleaseEvents } from "../events/publish.js";
import type { InsertedReleaseRow } from "../events/build-event.js";
import { buildEmbedConfig } from "../lib/embed-config.js";
import { RELEASES_BATCH_CHUNK_SIZE, RELEASES_ID_IN_CHUNK_SIZE } from "../lib/d1-limits.js";
import { invalidateLatestCache } from "../lib/latest-cache.js";
import { notifyIndexNowForSource } from "../lib/indexnow.js";
import { resolveOrgSlug, resolveProductSlug } from "../lib/slug-lookups.js";
import { logEvent } from "@releases/lib/log-event";

export const sourceRoutes = new Hono<Env>();

sourceRoutes.get("/sources", async (c) => {
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

  // Pagination: default limit 100, hard cap 500
  const limitParam = c.req.query("limit");
  const offsetParam = c.req.query("offset");
  const pageParam = c.req.query("page");
  const rawLimit = limitParam ? parseInt(limitParam, 10) : 100;
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 100 : Math.min(rawLimit, 500);
  const rawPage = pageParam ? parseInt(pageParam, 10) : 1;
  const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
  const rawOffset = offsetParam ? parseInt(offsetParam, 10) : (page - 1) * limit;
  const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  // Filter by URLs — return raw source rows matching the provided url params
  if (filterByUrls) {
    const urls = c.req.queries("url") ?? [];
    if (urls.length === 0) return c.json([]);
    const rows = await db.select().from(sources).where(inArray(sources.url, urls));
    return c.json(rows);
  }

  // Filter by org ID
  if (orgId) {
    const rows = await db
      .select()
      .from(sources)
      .where(eq(sources.orgId, orgId))
      .orderBy(sources.name);
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
  const wantsEnvelope = c.req.query("envelope") === "true";

  const sort = parseEnumParam(c.req.query("sort"), SOURCE_SORT_FIELDS, "name");
  const dir = parseSortDir(c.req.query("dir"), "asc");

  const [rows, totalItems] = await Promise.all([
    getSourcesWithStats(db, whereClause, { limit, offset, sort, dir }),
    wantsEnvelope ? countSourcesForList(db, whereClause) : Promise.resolve(null),
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
    const pagination: Pagination = {
      page: effectivePage,
      pageSize: limit,
      returned: result.length,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / limit)),
      hasMore: effectivePage * limit < totalItems,
    };
    return c.json({ items: result, pagination });
  }

  return c.json(result);
});

// ── Fetchable sources (must be before :slug route) ──

sourceRoutes.get("/sources/fetchable", async (c) => {
  const db = createDb(c.env.DB);
  const mode = c.req.query("mode"); // "unfetched" | "stale" | "retry_errors" | "all"
  const staleHours = c.req.query("staleHours");

  let rows: (typeof sources.$inferSelect)[];

  if (mode === "unfetched") {
    rows = await db
      .select()
      .from(sources)
      .where(and(sql`${sources.lastFetchedAt} IS NULL`, notDisabled));
  } else if (mode === "stale" && staleHours) {
    const hours = parseInt(staleHours, 10);
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    const now = new Date().toISOString();
    rows = await db
      .select()
      .from(sources)
      .where(
        and(
          sql`(${sources.lastFetchedAt} IS NULL OR ${sources.lastFetchedAt} < ${cutoff})`,
          sql`(${sources.nextFetchAfter} IS NULL OR ${sources.nextFetchAfter} <= ${now})`,
          sql`${sources.fetchPriority} != 'paused'`,
          notDisabled,
        ),
      );
  } else if (mode === "retry_errors") {
    rows = await db
      .select()
      .from(sources)
      .where(
        and(
          sql`${sources.id} IN (
          SELECT f.source_id FROM fetch_log f
          WHERE f.id = (SELECT f2.id FROM fetch_log f2 WHERE f2.source_id = f.source_id ORDER BY f2.created_at DESC LIMIT 1)
          AND f.status = 'error'
        )`,
          notDisabled,
        ),
      );
  } else {
    rows = await db.select().from(sources).where(notDisabled);
  }

  return c.json(rows);
});

// ── Feed and change-detection sources (must be before :slug route) ──

sourceRoutes.get("/sources/feeds", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(sources)
    .where(
      and(
        sql`json_extract(${sources.metadata}, '$.feedUrl') IS NOT NULL`,
        sql`${sources.fetchPriority} != 'paused'`,
        notDisabled,
      ),
    );
  return c.json(rows);
});

sourceRoutes.get("/sources/changes", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(sources)
    .where(and(isNotNull(sources.changeDetectedAt), notDisabled));
  return c.json(rows);
});

// ── Trigger fetch for a single source ──

sourceRoutes.post("/sources/:slug/fetch", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found" }, 404);

  let responsePayload: Record<string, unknown>;

  const meta = getSourceMeta(src);
  if (
    src.type === "feed" ||
    src.type === "github" ||
    (src.type === "scrape" && meta.feedUrl != null)
  ) {
    // Feed, GitHub, and scrape sources with a discovered feedUrl: fetch server-side
    const githubToken = await c.env.GITHUB_TOKEN?.get();
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

sourceRoutes.post("/sources/:slug/releases/batch", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found" }, 404);

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
    }>;
  }>();

  try {
    // D1 caps prepared statements at 100 bound parameters — see
    // `../lib/d1-limits.ts` for the math behind the chunk size.
    let inserted = 0;
    const publishRows: InsertedReleaseRow[] = [];
    for (let i = 0; i < body.releases.length; i += RELEASES_BATCH_CHUNK_SIZE) {
      const chunk = body.releases.slice(i, i + RELEASES_BATCH_CHUNK_SIZE).map((r) => ({
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
        });
      inserted += rows.length;
      for (const r of rows) publishRows.push(r);
    }
    const insertedIds = publishRows.map((r) => r.id);

    const [{ n: total }] = await db
      .select({ n: count() })
      .from(releases)
      .where(eq(releases.sourceId, src.id));

    // Fire-and-forget publish to the ReleaseHub DO so subscribers (CLI
    // `tail -f`, the upcoming web live view, webhook delivery) see new
    // releases in real time.
    if (publishRows.length > 0) {
      c.executionCtx.waitUntil(
        publishReleaseEvents(c.env, {
          src: { name: src.name, slug: src.slug, orgId: src.orgId, sourceId: src.id },
          inserted: publishRows,
        }),
      );
      c.executionCtx.waitUntil(
        invalidateLatestCache(c.env, {
          nReleases: publishRows.length,
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
          publishRows.length,
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
              contentSummary: string | null;
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
                  contentSummary: releases.contentSummary,
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
    logEvent("error", {
      component: "sources-batch",
      event: "insert-failed",
      sourceId: src.id,
      slug,
      err: err instanceof Error ? err : String(err),
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

  return c.json({ deleted: deleted.length });
});

sourceRoutes.post("/sources/:slug/content-hash", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);
  const peek = c.req.query("peek") === "true";
  const body = await c.req.json<{ contentHash: string }>();

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
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
});

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
sourceRoutes.patch("/sources/:slug/metadata", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);

  let patch: Record<string, unknown>;
  try {
    patch = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "bad_request", message: "Body must be a JSON object" }, 400);
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return c.json({ error: "bad_request", message: "Body must be a JSON object" }, 400);
  }

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const merged = mergeSourceMetadata(src.metadata, patch);
  const serialized = JSON.stringify(merged);
  if (serialized !== (src.metadata ?? "{}")) {
    await db.update(sources).set({ metadata: serialized }).where(eq(sources.id, src.id));
  }
  return c.json({ metadata: merged });
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
});

/**
 * Admin-only: list changelog file rows whose content length exceeds
 * `minBytes` (default 256KB — the live-encode cap in src/lib/tokens.ts).
 * Used by scripts/backfill-changelog-tokens.ts to find rows whose
 * cached `tokens` value is an estimate rather than an exact count.
 */
sourceRoutes.get("/sources/changelog-files/oversized", authMiddleware, async (c) => {
  const db = createDb(c.env.DB);
  const minBytes = parseInt(c.req.query("minBytes") ?? String(256 * 1024), 10);
  const rows = await db
    .select({
      sourceSlug: sources.slug,
      sourceName: sources.name,
      path: sourceChangelogFiles.path,
      filename: sourceChangelogFiles.filename,
      bytes: sourceChangelogFiles.bytes,
      tokens: sourceChangelogFiles.tokens,
      fetchedAt: sourceChangelogFiles.fetchedAt,
    })
    .from(sourceChangelogFiles)
    .innerJoin(sources, eq(sources.id, sourceChangelogFiles.sourceId))
    .where(sql`length(${sourceChangelogFiles.content}) > ${minBytes}`)
    .orderBy(sources.slug, sourceChangelogFiles.path);
  return c.json(rows);
});

/**
 * Admin-only: write an exact cached token count for a single changelog
 * file. Used by scripts/backfill-changelog-tokens.ts to replace the
 * chars/4 estimate on rows that exceed the live-encode cap. Targets the
 * file identified by `path` (defaults to the row selected by
 * `selectChangelogFile` when omitted).
 */
sourceRoutes.patch("/sources/:slug/changelog/tokens", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ tokens: number; path?: string }>();
  if (!Number.isFinite(body.tokens) || body.tokens < 0) {
    return c.json(
      { error: "invalid_tokens", message: "tokens must be a non-negative number" },
      400,
    );
  }

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
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
});

sourceRoutes.get("/sources/:slug", async (c) => {
  const slug = c.req.param("slug");
  const page = parseInt(c.req.query("page") ?? "1", 10);
  const pageSize = parseInt(c.req.query("pageSize") ?? "20", 10);
  const includeCoverage = parseBoolParam(c.req.query("include_coverage"));
  const db = createDb(c.env.DB);

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const offset = (page - 1) * pageSize;
  const notSuppressed = sql`(${releases.suppressed} IS NULL OR ${releases.suppressed} = 0)`;
  const cutoff = daysAgoIso(30);
  const cutoff90d = daysAgoIso(90);
  const dateCol = sql`COALESCE(${releases.publishedAt}, ${releases.fetchedAt})`;

  // Fire all independent reads in parallel — one D1 roundtrip wave instead of ~7 sequential ones.
  const orgQuery = src.orgId
    ? db
        .select({ slug: organizations.slug, name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, src.orgId))
    : Promise.resolve([]);

  // On page > 1 we can't derive latestVersion/latestDate from the paginated rows, so issue it in the same wave.
  const latestByDateQuery =
    page === 1
      ? Promise.resolve([])
      : db
          .select({ version: releases.version, publishedAt: releases.publishedAt })
          .from(releases)
          .where(
            and(
              eq(releases.sourceId, src.id),
              notSuppressed,
              sql`${releases.publishedAt} IS NOT NULL`,
            ),
          )
          .orderBy(desc(releases.publishedAt))
          .limit(1);

  const [
    releaseRows,
    orgRows,
    metricsRows,
    earliestRows,
    summaryRows,
    changelogExistsRows,
    latestByDateRows,
  ] = await Promise.all([
    getSourceReleasesPaginated(db, src.id, pageSize, offset, { includeCoverage }),
    orgQuery,
    db
      .select({
        total: count(),
        oldest: min(dateCol),
        recent: sql<number>`COUNT(CASE WHEN ${dateCol} >= ${cutoff} THEN 1 END)`,
        recent90d: sql<number>`COUNT(CASE WHEN ${dateCol} >= ${cutoff90d} THEN 1 END)`,
      })
      .from(releases)
      .where(and(eq(releases.sourceId, src.id), notSuppressed)),
    db
      .select({ date: min(releases.publishedAt) })
      .from(releases)
      .where(
        and(eq(releases.sourceId, src.id), notSuppressed, sql`${releases.publishedAt} IS NOT NULL`),
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

  const org = (orgRows[0] as { slug: string; name: string } | undefined) ?? null;
  const metrics = metricsRows[0];
  const earliest = earliestRows[0];
  const hasChangelogFile = changelogExistsRows.length > 0;

  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
  const releasesFormatted = releaseRows.map((r) => ({
    id: r.id,
    version: r.version,
    title: r.title,
    summary:
      r.content_summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
    content: hydrateMediaUrls(r.content, mediaOrigin),
    publishedAt: r.published_at,
    url: r.url,
    media: parseReleaseMedia(r.media, mediaOrigin),
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
        .select({ version: releases.version })
        .from(releases)
        .where(and(eq(releases.sourceId, src.id), notSuppressed))
        .orderBy(desc(releases.fetchedAt))
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
    org,
    isPrimary: src.isPrimary ?? false,
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
    pagination: { page, pageSize, totalPages, totalItems },
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
});

sourceRoutes.post("/sources", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{
    name: string;
    url: string;
    type?: string;
    slug?: string;
    orgId?: string;
    orgSlug?: string;
    metadata?: string;
    isPrimary?: boolean;
  }>();

  if (!body.name || !body.url) {
    return c.json({ error: "bad_request", message: "Missing required fields: name, url" }, 400);
  }

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

  // Auto-detect feed type when metadata contains a feedUrl and no explicit type was provided
  let type = body.type ?? "scrape";
  if (!body.type && body.metadata) {
    try {
      const meta = JSON.parse(body.metadata);
      if (meta.feedUrl) type = "feed";
    } catch {
      /* invalid metadata JSON — ignore */
    }
  }

  // Resolve org by slug if orgSlug provided (preferred over raw orgId)
  let orgId = body.orgId ?? null;
  if (!orgId && body.orgSlug) {
    const [org] = await db.select().from(organizations).where(orgWhere(body.orgSlug));
    orgId = org?.id ?? null;
  }

  // Insert with auto-suffix on slug collision: try base, then base-2 … base-20.
  // Loop-with-catch is race-safe: no TOCTOU gap between check and insert.
  const MAX_SLUG_ATTEMPTS = 20;
  const createdAt = new Date().toISOString();
  const insertValues = (slug: string) => ({
    name: body.name,
    slug,
    type: type as "github" | "scrape" | "feed" | "agent",
    url: body.url,
    orgId,
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

  return c.json(source, 201);
});

sourceRoutes.patch("/sources/:slug", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<SourcePatchInput>();

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
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
  return c.json(updated);
});

sourceRoutes.delete("/sources/:slug", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const orgId = src.orgId;
  await db.delete(sources).where(eq(sources.id, src.id));
  if (orgId) c.executionCtx.waitUntil(regeneratePlaybook(db, orgId));
  return c.json({ deleted: true });
});

// Bulk release insert for data seeding
sourceRoutes.post("/sources/:slug/releases", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [src] = await db.select().from(sources).where(sourceWhere(slug));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const body = await c.req.json<{
    id?: string;
    version?: string;
    title: string;
    content: string;
    contentSummary?: string;
    url?: string;
    contentHash?: string;
    metadata?: string;
    publishedAt?: string;
    fetchedAt?: string;
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
  } catch {
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

  const media = parseReleaseMedia(release.media as string | null, mediaOrigin);

  const hydratedContent = hydrateMediaUrls(release.content as string, mediaOrigin);
  const result = {
    ...release,
    content: hydratedContent,
    media,
    sourceName,
    sourceSlug,
    sourceType,
    org,
  };

  if (wantsMarkdown(c)) {
    return markdownResponse(c, releaseToMarkdown(result as any));
  }

  return c.json(result);
});

sourceRoutes.delete("/releases/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");

  const deleted = await db
    .delete(releases)
    .where(eq(releases.id, id))
    .returning({ id: releases.id });
  if (deleted.length === 0)
    return c.json({ error: "not_found", message: "Release not found" }, 404);

  return c.json({ deleted: true });
});

sourceRoutes.patch("/releases/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    title?: string;
    version?: string;
    content?: string;
    url?: string;
    publishedAt?: string;
    contentHash?: string;
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

  const [updated] = await db
    .update(releases)
    .set({
      suppressed: true,
      suppressedReason: (body as { reason?: string }).reason ?? null,
    })
    .where(eq(releases.id, id))
    .returning({ id: releases.id });

  if (!updated) return c.json({ error: "not_found", message: "Release not found" }, 404);
  return c.json({ suppressed: true });
});

sourceRoutes.post("/releases/:id/unsuppress", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");

  const [updated] = await db
    .update(releases)
    .set({
      suppressed: false,
      suppressedReason: null,
    })
    .where(eq(releases.id, id))
    .returning({ id: releases.id });

  if (!updated) return c.json({ error: "not_found", message: "Release not found" }, 404);
  return c.json({ unsuppressed: true });
});

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
