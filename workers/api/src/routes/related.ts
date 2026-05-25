/**
 * GET /v1/related/releases  — returns releases semantically similar to an anchor release.
 * GET /v1/related/sources   — returns sources semantically similar to an anchor source.
 *
 * Both endpoints pull the anchor's vector from the relevant Vectorize index
 * via `getByIds`, then run a follow-up `query` with that vector. Scope is
 * narrowed by `scope=org` (Vectorize metadata filter on `org_id`) or
 * `scope=global` (default). The anchor itself is always excluded from its
 * own results.
 *
 * Degrades gracefully: if bindings are missing, the anchor has no vector,
 * or Vectorize errors, the response is `{ degraded: true, items: [] }`.
 * Callers render nothing in that case.
 */

import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { sql, inArray, eq } from "drizzle-orm";
import {
  sources,
  sourcesActive,
  organizationsActive,
  releases,
} from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import { sourceMatchByIdOrSlug, parseReleaseMedia } from "../utils.js";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { logEvent } from "@releases/lib/log-event";
import {
  scoreRelatedRelease,
  recencyMultiplier,
  RELATED_GLOBAL_MIN_RANK,
} from "../related-ranking.js";
import {
  RelatedReleasesResponseSchema,
  RelatedSourcesResponseSchema,
  ErrorResponseSchema,
} from "@buildinternet/releases-api-types";
import type { RelatedReleaseItem, RelatedSourceItem } from "@buildinternet/releases-api-types";
import type { Env } from "../index.js";
import type { D1Db } from "../db.js";

export const relatedRoutes = new Hono<Env>();

// ── Shared types ─────────────────────────────────────────────────────────

type ReadOnlyVectorizeIndex = {
  query(
    vector: number[],
    options?: {
      topK?: number;
      returnMetadata?: boolean | "none" | "indexed" | "all";
      filter?: Record<string, unknown>;
    },
  ): Promise<{
    matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }>;
  }>;
  /** Vectorize v2 — returns the full vector rows for the given ids. */
  getByIds?(ids: string[]): Promise<Array<{ id: string; values: number[] }>>;
};

type RelatedScope = "org" | "global";

function parseScope(raw: string | undefined): RelatedScope {
  return raw === "org" ? "org" : "global";
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = parseInt(raw ?? String(fallback), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function degraded(reason: string) {
  return { degraded: true as const, degradedReason: reason, items: [] };
}

// Item shapes (`RelatedReleaseItem`, `RelatedSourceItem`) are imported from
// `@buildinternet/releases-api-types` — single source of truth, used by both
// the route handlers and the OpenAPI document.

// ── /v1/related/releases ─────────────────────────────────────────────────

relatedRoutes.get(
  "/related/releases",
  describeRoute({
    tags: ["Related"],
    summary: "Releases semantically similar to an anchor release",
    description:
      "Pulls the anchor's vector from the `RELEASES_INDEX` Vectorize index via `getByIds`, then runs a follow-up `query` with that vector. The anchor itself is always excluded from results. `scope=org` filters by the anchor's org id (Vectorize metadata filter on `org_id`); `scope=global` (default) is unscoped.\n\n**Degrades gracefully:** when the binding is missing, the anchor isn't embedded yet, or Vectorize errors, the response is `{ degraded: true, degradedReason, items: [] }` with HTTP 200 — callers render nothing in that case. `degradedReason` is human-readable and not stable.\n\n**Ranking:** `topK` is over-fetched (`min(max(limit * 10, 50), 100)`), then candidates are ranked server-side by `cosine × recency × contentWeight` and sliced to `limit`. Content-free releases (empty bodies, boilerplate \"no changes\" notes) are dropped entirely; short-but-real releases are down-weighted; recency uses a 45-day half-life. Items are returned already in display order.",
    parameters: [
      {
        name: "release",
        in: "query",
        required: true,
        schema: { type: "string" },
        description: "Anchor release id (`rel_…`).",
      },
      {
        name: "scope",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["org", "global"], default: "global" },
        description: "Restrict candidates to the anchor's org, or run unscoped.",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 25, default: 8 },
        description: "Max neighbors to return. Clamped to 1–25.",
      },
      {
        name: "excludeOrg",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Org slug to drop from results before slicing. Used by the global rail to avoid overlap with an org-scoped rail rendered alongside it.",
      },
    ],
    responses: {
      200: {
        description: "Successful or degraded neighbor list.",
        content: { "application/json": { schema: resolver(RelatedReleasesResponseSchema) } },
      },
      400: {
        description: "Missing `release` query parameter.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "No release matches the supplied id.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const anchorId = c.req.query("release");
    if (!anchorId) {
      return c.json(
        { error: "bad_request", message: "Missing required query parameter: release" },
        400,
      );
    }
    const scope = parseScope(c.req.query("scope"));
    const limit = clampLimit(c.req.query("limit"), 8, 25);
    const excludeOrg = c.req.query("excludeOrg")?.trim() || null;
    const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";

    const index = c.env.RELEASES_INDEX as unknown as ReadOnlyVectorizeIndex | undefined;
    if (!index || typeof index.getByIds !== "function") {
      logEvent("error", {
        component: "related-releases",
        event: "binding-unavailable",
        binding: "RELEASES_INDEX",
      });
      return c.json(degraded("RELEASES_INDEX unavailable"));
    }

    const db = createDb(c.env.DB);

    // Resolve the anchor release — we need its orgId for scope=org and we
    // also want to 404 on a bogus id rather than bill an embedding call.
    const [anchor] = await db
      .select({
        id: releases.id,
        sourceId: releases.sourceId,
        orgId: sourcesActive.orgId,
      })
      .from(releases)
      .innerJoin(sourcesActive, eq(sourcesActive.id, releases.sourceId))
      .where(eq(releases.id, anchorId));
    if (!anchor) {
      return c.json({ error: "not_found", message: "Release not found" }, 404);
    }

    let anchorVector: number[] | null = null;
    try {
      const rows = await index.getByIds([anchor.id]);
      anchorVector = rows[0]?.values ?? null;
    } catch (err) {
      logEvent("error", {
        component: "related-releases",
        event: "get-by-ids-failed",
        anchorId: anchor.id,
        err,
      });
      return c.json(degraded(err instanceof Error ? err.message : String(err)));
    }
    if (!anchorVector || anchorVector.length === 0) {
      // Anchor hasn't been embedded yet — not an error, just no neighbors.
      return c.json({ degraded: true as const, degradedReason: "anchor not embedded", items: [] });
    }

    // Over-fetch hard: we rank cosine × recency × content server-side and drop
    // content-free candidates, so the raw neighbor pool needs real headroom to
    // survive filtering. Capped at Vectorize's 100-match ceiling.
    const topK = Math.min(Math.max(limit * 10, 50), 100);
    const filter: Record<string, unknown> | undefined =
      scope === "org" && anchor.orgId ? { org_id: anchor.orgId } : undefined;

    let matches: Array<{ id: string; score: number }>;
    try {
      const res = await index.query(anchorVector, {
        topK,
        returnMetadata: "none",
        filter,
      });
      matches = res.matches.map((m) => ({ id: m.id, score: m.score }));
    } catch (err) {
      logEvent("error", {
        component: "related-releases",
        event: "query-failed",
        anchorId: anchor.id,
        scope,
        err,
      });
      return c.json(degraded(err instanceof Error ? err.message : String(err)));
    }

    // The anchor's own vector is the top hit; bail only when nothing else came back.
    if (!matches.some((m) => m.id !== anchor.id)) {
      return c.json({ scope, items: [] as RelatedReleaseItem[] });
    }

    // The global rail competes against every product, so hide weak matches
    // (a stale, low-similarity pool means "nothing good out there"). The org
    // rail is inherently scoped, so it shows its best even when modest.
    const minRank = scope === "global" ? RELATED_GLOBAL_MIN_RANK : 0;
    const items = await hydrateReleaseNeighbors(
      db,
      matches,
      anchor.id,
      limit,
      mediaOrigin,
      excludeOrg,
      minRank,
    );
    return c.json({ scope, items });
  },
);

async function hydrateReleaseNeighbors(
  db: D1Db,
  matches: Array<{ id: string; score: number }>,
  anchorId: string,
  limit: number,
  mediaOrigin: string,
  excludeOrg: string | null,
  minRank: number,
): Promise<RelatedReleaseItem[]> {
  const ids = matches.map((m) => m.id).filter((id) => id !== anchorId);
  if (ids.length === 0) return [];

  const rows = await db.all<{
    id: string;
    title: string;
    version: string | null;
    url: string | null;
    publishedAt: string | null;
    summary: string;
    contentChars: number;
    titleGenerated: string | null;
    titleShort: string | null;
    media: string | null;
    sourceId: string;
    sourceSlug: string;
    sourceName: string;
    productName: string | null;
    orgSlug: string | null;
    orgName: string | null;
    orgAvatarUrl: string | null;
  }>(sql`
    SELECT r.id as id,
           r.title as title,
           r.version as version,
           r.url as url,
           r.published_at as publishedAt,
           COALESCE(r.summary, SUBSTR(r.content, 1, 300)) as summary,
           COALESCE(r.content_chars, LENGTH(r.content), LENGTH(r.summary), 0) as contentChars,
           r.title_generated as titleGenerated,
           r.title_short as titleShort,
           r.media as media,
           s.id as sourceId,
           s.slug as sourceSlug,
           s.name as sourceName,
           p.name as productName,
           o.slug as orgSlug,
           o.name as orgName,
           o.avatar_url as orgAvatarUrl
    FROM releases_visible r
    JOIN sources_active s ON s.id = r.source_id
    LEFT JOIN products_active p ON p.id = s.product_id
    LEFT JOIN organizations_active o ON o.id = s.org_id
    WHERE r.id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
  `);

  const byId = new Map<string, (typeof rows)[number]>();
  for (const row of rows) byId.set(row.id, row);

  // Rank every surviving candidate by cosine × recency × content quality,
  // dropping content-free releases, (optionally) one org, and anything below
  // `minRank`, then slice. We rank the full pool rather than walking cosine
  // order so recent, content-rich matches can overtake a closer-but-stale or
  // closer-but-empty neighbor.
  const now = Date.now();
  const ranked: Array<{ item: RelatedReleaseItem; rank: number }> = [];
  for (const m of matches) {
    if (m.id === anchorId) continue;
    const row = byId.get(m.id);
    if (!row) continue;
    if (excludeOrg && row.orgSlug === excludeOrg) continue;

    const { tier, rank } = scoreRelatedRelease(
      {
        score: m.score,
        publishedAt: row.publishedAt,
        summary: row.summary,
        contentChars: row.contentChars,
      },
      now,
    );
    if (tier === "empty") continue;
    if (rank < minRank) continue;

    ranked.push({
      rank,
      item: {
        id: row.id,
        title: row.title,
        version: row.version,
        url: row.url,
        publishedAt: row.publishedAt,
        summary: row.summary,
        titleGenerated: row.titleGenerated,
        titleShort: row.titleShort,
        thumbnail: firstImageThumbnail(row.media, mediaOrigin),
        score: m.score,
        source: {
          id: row.sourceId,
          slug: row.sourceSlug,
          name: row.sourceName,
          productName: row.productName,
          orgSlug: row.orgSlug,
          orgName: row.orgName,
          orgAvatarUrl: row.orgAvatarUrl,
        },
      },
    });
  }

  return ranked
    .toSorted((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map((r) => r.item);
}

/**
 * Pick the first image-like media entry from a parsed media array. Returns
 * null when the row has no usable image — rail consumers then fall back to
 * a text-only card.
 */
function firstImageThumbnail(
  raw: string | null,
  mediaOrigin: string,
): { url: string; alt?: string } | null {
  const media = parseReleaseMedia(raw, mediaOrigin);
  const first = media.find((m) => m.type === "image" || m.type === "gif");
  if (!first) return null;
  const url = first.r2Url ?? first.url;
  if (!url) return null;
  return first.alt ? { url, alt: first.alt } : { url };
}

// ── /v1/related/sources ──────────────────────────────────────────────────

relatedRoutes.get(
  "/related/sources",
  describeRoute({
    tags: ["Related"],
    summary: "Sources semantically similar to an anchor source",
    description:
      "Pulls the anchor source's vector from the polymorphic `ENTITIES_INDEX` (orgs + products + sources) via `getByIds`, then runs `query` restricted to `type=source` so the candidate pool isn't wasted on parent orgs/products that would be filtered out post-hydration anyway. `scope=org` adds an `org_id` filter; `scope=global` (default) keeps the source filter only.\n\n**Degrades gracefully** the same way `/v1/related/releases` does — missing binding, unembedded anchor, or query error returns `{ degraded: true, degradedReason, items: [] }` with HTTP 200.\n\nEach surviving row carries its source basics plus an org rollup and a recent-release window-function stat block (`releaseCount`, `latestDate`, `latestTitle`, `latestVersion`, `recentCount`) so a rail card can render without follow-up requests.",
    parameters: [
      {
        name: "source",
        in: "query",
        required: true,
        schema: { type: "string" },
        description: "Anchor source id (`src_…`) or slug.",
      },
      {
        name: "scope",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["org", "global"], default: "global" },
        description: "Restrict candidates to the anchor's org, or run unscoped.",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 25, default: 6 },
        description: "Max neighbors to return. Clamped to 1–25.",
      },
    ],
    responses: {
      200: {
        description: "Successful or degraded neighbor list.",
        content: { "application/json": { schema: resolver(RelatedSourcesResponseSchema) } },
      },
      400: {
        description: "Missing `source` query parameter.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "No source matches the supplied identifier.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const anchorParam = c.req.query("source");
    if (!anchorParam) {
      return c.json(
        { error: "bad_request", message: "Missing required query parameter: source" },
        400,
      );
    }
    const scope = parseScope(c.req.query("scope"));
    const limit = clampLimit(c.req.query("limit"), 6, 25);

    const index = c.env.ENTITIES_INDEX as unknown as ReadOnlyVectorizeIndex | undefined;
    if (!index || typeof index.getByIds !== "function") {
      logEvent("error", {
        component: "related-sources",
        event: "binding-unavailable",
        binding: "ENTITIES_INDEX",
      });
      return c.json(degraded("ENTITIES_INDEX unavailable"));
    }

    const db = createDb(c.env.DB);

    // Resolve the anchor source (accepts slug or id).
    const [anchor] = await db
      .select({
        id: sources.id,
        slug: sources.slug,
        orgId: sources.orgId,
      })
      .from(sources)
      .where(sourceMatchByIdOrSlug(anchorParam));
    if (!anchor) {
      return c.json({ error: "not_found", message: "Source not found" }, 404);
    }

    let anchorVector: number[] | null = null;
    try {
      const rows = await index.getByIds([anchor.id]);
      anchorVector = rows[0]?.values ?? null;
    } catch (err) {
      logEvent("error", {
        component: "related-sources",
        event: "get-by-ids-failed",
        anchorId: anchor.id,
        err,
      });
      return c.json(degraded(err instanceof Error ? err.message : String(err)));
    }
    if (!anchorVector || anchorVector.length === 0) {
      return c.json({ degraded: true as const, degradedReason: "anchor not embedded", items: [] });
    }

    // Entities index is polymorphic (orgs + products + sources). Restrict the
    // candidate pool to `type=source` so we don't waste topK slots on parent
    // orgs/products that would be filtered out post-hydration anyway.
    const filter: Record<string, unknown> = { type: "source" };
    if (scope === "org" && anchor.orgId) filter.org_id = anchor.orgId;

    // Over-fetch so the recency rerank below has real headroom after
    // hidden/suppressed filtering thins the pool.
    const topK = Math.max(limit * 3, 25);
    let matches: Array<{ id: string; score: number }>;
    try {
      const res = await index.query(anchorVector, {
        topK,
        returnMetadata: "none",
        filter,
      });
      matches = res.matches.map((m) => ({ id: m.id, score: m.score }));
    } catch (err) {
      logEvent("error", {
        component: "related-sources",
        event: "query-failed",
        anchorId: anchor.id,
        scope,
        err,
      });
      return c.json(degraded(err instanceof Error ? err.message : String(err)));
    }

    const neighborIds = matches.map((m) => m.id).filter((id) => id !== anchor.id);
    if (neighborIds.length === 0) {
      return c.json({ scope, items: [] as RelatedSourceItem[] });
    }

    const rows = await db
      .select({
        id: sourcesActive.id,
        slug: sourcesActive.slug,
        name: sourcesActive.name,
        type: sourcesActive.type,
        url: sourcesActive.url,
        orgId: sourcesActive.orgId,
        isHidden: sourcesActive.isHidden,
      })
      .from(sourcesActive)
      .where(inArray(sourcesActive.id, neighborIds));

    const visibleById = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (row.isHidden) continue;
      visibleById.set(row.id, row);
    }

    // Collect orgs in a single batched lookup.
    const orgIds = [...new Set(rows.map((r) => r.orgId).filter((x): x is string => !!x))];
    const orgRows =
      orgIds.length > 0
        ? await db
            .select({
              id: organizationsActive.id,
              slug: organizationsActive.slug,
              name: organizationsActive.name,
              avatarUrl: organizationsActive.avatarUrl,
            })
            .from(organizationsActive)
            .where(inArray(organizationsActive.id, orgIds))
        : [];
    const orgById = new Map<string, { slug: string; name: string; avatarUrl: string | null }>();
    for (const o of orgRows)
      orgById.set(o.id, { slug: o.slug, name: o.name, avatarUrl: o.avatarUrl });

    // Release stats per neighbor source — a single window-function query so we
    // can return both the aggregates (release count, latest date, recent count)
    // and the fields *of* the latest release (title, version) without a second
    // roundtrip. ROW_NUMBER lets us pick exactly one row per source.
    const visibleIds = [...visibleById.keys()];
    const recentCutoffIso = daysAgoIso(30);
    const statsRows: Array<{
      sourceId: string;
      n: number;
      latest: string | null;
      latestTitle: string | null;
      latestVersion: string | null;
      recentCount: number;
    }> =
      visibleIds.length > 0
        ? await db.all<{
            sourceId: string;
            n: number;
            latest: string | null;
            latestTitle: string | null;
            latestVersion: string | null;
            recentCount: number;
          }>(sql`
          SELECT sourceId, n, latest, latestTitle, latestVersion, recentCount
          FROM (
            SELECT r.source_id                                               AS sourceId,
                   r.title                                                   AS latestTitle,
                   r.version                                                 AS latestVersion,
                   COUNT(*) OVER (PARTITION BY r.source_id)                  AS n,
                   MAX(r.published_at) OVER (PARTITION BY r.source_id)       AS latest,
                   SUM(CASE WHEN r.published_at >= ${recentCutoffIso} THEN 1 ELSE 0 END)
                     OVER (PARTITION BY r.source_id)                         AS recentCount,
                   ROW_NUMBER() OVER (
                     PARTITION BY r.source_id
                     ORDER BY r.published_at DESC NULLS LAST
                   )                                                          AS rn
            FROM releases_visible r
            WHERE r.source_id IN (${sql.join(
              visibleIds.map((id) => sql`${id}`),
              sql`, `,
            )})
          ) AS ranked
          WHERE rn = 1
        `)
        : [];
    const statsById = new Map<string, (typeof statsRows)[number]>();
    for (const row of statsRows) statsById.set(row.sourceId, row);

    // Rank by cosine × recency of the source's latest release (45-day
    // half-life), so a semantically-close but dormant source falls behind a
    // slightly-less-close but actively-shipping one. Build the full candidate
    // set first, then sort and slice — no content weighting (a source isn't a
    // body of content).
    const now = Date.now();
    const ranked: Array<{ item: RelatedSourceItem; rank: number }> = [];
    for (const m of matches) {
      if (m.id === anchor.id) continue;
      const row = visibleById.get(m.id);
      if (!row) continue;
      const org = row.orgId ? orgById.get(row.orgId) : undefined;
      const stats = statsById.get(row.id);
      const latestDate = stats?.latest ?? null;
      ranked.push({
        rank: m.score * recencyMultiplier(latestDate, now),
        item: {
          id: row.id,
          slug: row.slug,
          name: row.name,
          type: row.type,
          url: row.url,
          score: m.score,
          orgSlug: org?.slug ?? null,
          orgName: org?.name ?? null,
          orgAvatarUrl: org?.avatarUrl ?? null,
          releaseCount: stats?.n ?? 0,
          latestDate,
          latestTitle: stats?.latestTitle ?? null,
          latestVersion: stats?.latestVersion ?? null,
          recentCount: stats?.recentCount ?? 0,
        },
      });
    }

    const items = ranked
      .toSorted((a, b) => b.rank - a.rank)
      .slice(0, limit)
      .map((r) => r.item);

    return c.json({ scope, items });
  },
);
