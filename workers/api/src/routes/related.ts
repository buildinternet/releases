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
import { sql, inArray, eq } from "drizzle-orm";
import {
  sources,
  sourcesActive,
  organizationsActive,
  releases,
} from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import { sourceMatchByIdOrSlug, parseReleaseMedia } from "../utils.js";
import { logEvent } from "@releases/lib/log-event";
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

interface RelatedReleaseItem {
  id: string;
  title: string;
  version: string | null;
  url: string | null;
  publishedAt: string | null;
  summary: string;
  titleGenerated: string | null;
  titleShort: string | null;
  /** @deprecated Use `titleGenerated`. */
  contentTitle: string | null;
  /** @deprecated Use `titleShort`. */
  contentTitleShort: string | null;
  thumbnail: { url: string; alt?: string } | null;
  score: number;
  source: {
    id: string;
    slug: string;
    name: string;
    orgSlug: string | null;
    orgName: string | null;
  };
}

interface RelatedSourceItem {
  id: string;
  slug: string;
  name: string;
  type: string;
  url: string | null;
  score: number;
  orgSlug: string | null;
  orgName: string | null;
  orgAvatarUrl: string | null;
  releaseCount: number;
  latestDate: string | null;
  latestTitle: string | null;
  latestVersion: string | null;
  /** Total releases published in the last 30 days (includes the latest). */
  recentCount: number;
}

// ── /v1/related/releases ─────────────────────────────────────────────────

relatedRoutes.get("/related/releases", async (c) => {
  const anchorId = c.req.query("release");
  if (!anchorId) {
    return c.json(
      { error: "bad_request", message: "Missing required query parameter: release" },
      400,
    );
  }
  const scope = parseScope(c.req.query("scope"));
  const limit = clampLimit(c.req.query("limit"), 8, 25);
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

  // Over-fetch hard: the web layer reranks semantic score against publishedAt
  // to bias toward recent items, so give it at least 25 candidates even when
  // the caller asked for a few.
  const topK = Math.max(limit * 3, 25);
  const filter: Record<string, unknown> | undefined =
    scope === "org" && anchor.orgId ? { org_id: anchor.orgId } : undefined;

  let matches: Array<{ id: string; score: number }>;
  try {
    const res = await index.query(anchorVector, {
      topK,
      returnMetadata: "none",
      ...(filter ? { filter } : {}),
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

  const neighborIds = matches.map((m) => m.id).filter((id) => id !== anchor.id);
  if (neighborIds.length === 0) {
    return c.json({ scope, items: [] as RelatedReleaseItem[] });
  }

  const items = await hydrateReleaseNeighbors(db, matches, anchor.id, limit, mediaOrigin);
  return c.json({ scope, items });
});

async function hydrateReleaseNeighbors(
  db: D1Db,
  matches: Array<{ id: string; score: number }>,
  anchorId: string,
  limit: number,
  mediaOrigin: string,
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
    titleGenerated: string | null;
    titleShort: string | null;
    media: string | null;
    sourceId: string;
    sourceSlug: string;
    sourceName: string;
    orgSlug: string | null;
    orgName: string | null;
  }>(sql`
    SELECT r.id as id,
           r.title as title,
           r.version as version,
           r.url as url,
           r.published_at as publishedAt,
           COALESCE(r.summary, SUBSTR(r.content, 1, 300)) as summary,
           r.title_generated as titleGenerated,
           r.title_short as titleShort,
           r.media as media,
           s.id as sourceId,
           s.slug as sourceSlug,
           s.name as sourceName,
           o.slug as orgSlug,
           o.name as orgName
    FROM releases_visible r
    JOIN sources_active s ON s.id = r.source_id
    LEFT JOIN organizations_active o ON o.id = s.org_id
    WHERE r.id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
  `);

  const byId = new Map<string, (typeof rows)[number]>();
  for (const row of rows) byId.set(row.id, row);

  const out: RelatedReleaseItem[] = [];
  for (const m of matches) {
    if (m.id === anchorId) continue;
    const row = byId.get(m.id);
    if (!row) continue;
    out.push({
      id: row.id,
      title: row.title,
      version: row.version,
      url: row.url,
      publishedAt: row.publishedAt,
      summary: row.summary,
      titleGenerated: row.titleGenerated,
      titleShort: row.titleShort,
      contentTitle: row.titleGenerated,
      contentTitleShort: row.titleShort,
      thumbnail: firstImageThumbnail(row.media, mediaOrigin),
      score: m.score,
      source: {
        id: row.sourceId,
        slug: row.sourceSlug,
        name: row.sourceName,
        orgSlug: row.orgSlug,
        orgName: row.orgName,
      },
    });
    if (out.length >= limit) break;
  }
  return out;
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

relatedRoutes.get("/related/sources", async (c) => {
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

  // Over-fetch so the web layer can rerank by recency without running out
  // of candidates after hidden/suppressed filtering.
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
  const recentCutoffIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
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

  const items: RelatedSourceItem[] = [];
  for (const m of matches) {
    if (m.id === anchor.id) continue;
    const row = visibleById.get(m.id);
    if (!row) continue;
    const org = row.orgId ? orgById.get(row.orgId) : undefined;
    const stats = statsById.get(row.id);
    items.push({
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
      latestDate: stats?.latest ?? null,
      latestTitle: stats?.latestTitle ?? null,
      latestVersion: stats?.latestVersion ?? null,
      recentCount: stats?.recentCount ?? 0,
    });
    if (items.length >= limit) break;
  }

  return c.json({ scope, items });
});
