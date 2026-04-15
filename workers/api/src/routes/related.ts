/**
 * "Related" rails for source detail pages.
 *
 *   GET /v1/related/releases?release=<id>&scope=org|global&limit=N
 *   GET /v1/related/sources?source=<slug|id>&scope=org|global&limit=N
 *
 * Both routes query Vectorize by the anchor's existing vector (pulled via
 * `getByIds`) — no re-embedding. The anchor is always excluded from its own
 * result list. `scope=org` applies a Vectorize metadata filter on `org_id`;
 * `scope=global` is unfiltered.
 *
 * Degradation contract matches `workers/api/src/routes/search.ts`: when the
 * Vectorize binding is missing, the anchor has no vector yet (not embedded),
 * or the `.query()` call fails, we return `items: []` with `degraded: true`
 * and a `degradedReason`. The route never 500s on a missing ingest.
 *
 * Why by-vector instead of by-text: the release/source title alone carries
 * very little semantic signal. The release-index vector was built from
 * title + content (see `src/lib/embed-releases.ts#buildReleaseText`); the
 * entity-index vector was built from name + description + category +
 * domain. Reusing them keeps "related" results consistent with semantic
 * search.
 */

import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createDb, type D1Db } from "../db.js";
import {
  sources,
  organizations,
  releases,
} from "@releases/db/schema.js";
import { sourceWhere } from "../utils.js";
import type { Env } from "../index.js";
import type {
  VectorizeIndex,
  VectorMetadataValue,
} from "@releases/lib/vector-search.js";

export const relatedRoutes = new Hono<Env>();

// Cloudflare workers-types declares `VectorizeIndex` with a stricter metadata
// value type than the runtime-agnostic interface under `src/lib/vector-search.ts`.
// Assignable at runtime; the narrowing only matters for the upsert side, which
// we never hit here.
function asSharedIndex(index: unknown): VectorizeIndex {
  return index as VectorizeIndex;
}

type Scope = "org" | "global";

interface RelatedReleaseItem {
  id: string;
  title: string;
  version: string | null;
  url: string | null;
  publishedAt: string | null;
  summary: string;
  score: number;
  source: { id: string; slug: string; name: string };
  orgSlug: string | null;
}

interface RelatedSourceItem {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  score: number;
  orgSlug: string | null;
  orgName: string | null;
  releaseCount: number;
  latestDate: string | null;
}

interface RelatedResponseBase {
  anchor: { id: string };
  scope: Scope;
  degraded: boolean;
  degradedReason?: string;
}

interface RelatedReleasesResponse extends RelatedResponseBase {
  items: RelatedReleaseItem[];
}

interface RelatedSourcesResponse extends RelatedResponseBase {
  items: RelatedSourceItem[];
}

// ── helpers (exported for unit tests) ────────────────────────────────

export function parseScope(raw: string | undefined): Scope {
  return raw === "org" ? "org" : "global";
}

export function parseLimit(raw: string | undefined, fallback = 6, cap = 20): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, cap);
}

/**
 * Pure: drop the anchor id from `matches`, keep IDs with the expected
 * prefix (or any prefix when `prefix` is undefined), and stop once we
 * have enough candidates. Returned IDs preserve Vectorize ranking order.
 */
export function pickCandidates(
  matches: Array<{ id: string; score: number }>,
  anchorId: string,
  limit: number,
  prefix?: string,
): string[] {
  const out: string[] = [];
  for (const m of matches) {
    if (m.id === anchorId) continue;
    if (prefix && !m.id.startsWith(prefix)) continue;
    out.push(m.id);
    if (out.length >= limit * 2) break;
  }
  return out;
}

function degraded<T>(
  anchor: { id: string },
  scope: Scope,
  reason: string,
  empty: T,
): T & RelatedResponseBase {
  return {
    anchor,
    scope,
    degraded: true,
    degradedReason: reason,
    ...empty,
  } as T & RelatedResponseBase;
}

async function getAnchorVector(
  index: VectorizeIndex | undefined,
  id: string,
): Promise<{ values: number[]; metadata?: Record<string, VectorMetadataValue> } | null> {
  if (!index) return null;
  try {
    const rows = await index.getByIds([id]);
    const row = rows.find((r) => r.id === id);
    if (!row) return null;
    return { values: row.values, metadata: row.metadata };
  } catch {
    return null;
  }
}

// ── GET /v1/related/releases ──────────────────────────────────────────

relatedRoutes.get("/related/releases", async (c) => {
  const releaseId = c.req.query("release") ?? "";
  if (!releaseId) {
    return c.json(
      { error: "bad_request", message: "Missing required query parameter: release" },
      400,
    );
  }
  const scope = parseScope(c.req.query("scope"));
  const limit = parseLimit(c.req.query("limit"));

  const db = createDb(c.env.DB);

  // Verify the anchor exists + pull the parent org for scope=org. We need
  // both the D1 row and the vector — but if D1 doesn't know the release
  // that's a real 404, not a degraded state.
  const [anchorRow] = await db
    .select({
      id: releases.id,
      sourceId: releases.sourceId,
      orgId: sources.orgId,
    })
    .from(releases)
    .leftJoin(sources, eq(releases.sourceId, sources.id))
    .where(eq(releases.id, releaseId));
  if (!anchorRow) {
    return c.json({ error: "not_found", message: "Release not found" }, 404);
  }
  const anchor = { id: anchorRow.id };

  if (scope === "org" && !anchorRow.orgId) {
    // Independent source with no org — "scope=org" is meaningless here.
    return c.json<RelatedReleasesResponse>({
      anchor,
      scope,
      degraded: false,
      items: [],
    });
  }

  const index = c.env.RELEASES_INDEX;
  const vec = await getAnchorVector(asSharedIndex(index), releaseId);
  if (!vec) {
    return c.json<RelatedReleasesResponse>(
      degraded<{ items: RelatedReleaseItem[] }>(
        anchor,
        scope,
        "anchor vector unavailable — release not yet embedded or Vectorize binding missing",
        { items: [] },
      ),
    );
  }

  // Over-fetch so we have headroom after dropping the anchor + anything
  // filtered out in hydration. Vectorize `filter` uses the metadata key we
  // upsert in `embed-releases.ts` (`org_id`).
  const topK = limit + 5;
  let matches: Array<{ id: string; score: number }>;
  try {
    const res = await asSharedIndex(index).query(vec.values, {
      topK,
      returnMetadata: "none",
      ...(scope === "org" && anchorRow.orgId
        ? { filter: { org_id: anchorRow.orgId } }
        : {}),
    });
    matches = res.matches.map((m) => ({ id: m.id, score: m.score }));
  } catch (err) {
    return c.json<RelatedReleasesResponse>(
      degraded<{ items: RelatedReleaseItem[] }>(
        anchor,
        scope,
        err instanceof Error ? err.message : String(err),
        { items: [] },
      ),
    );
  }

  const filteredIds = pickCandidates(matches, releaseId, limit);
  if (filteredIds.length === 0) {
    return c.json<RelatedReleasesResponse>({
      anchor,
      scope,
      degraded: false,
      items: [],
    });
  }

  const scoreById = new Map(matches.map((m) => [m.id, m.score]));
  const hydrated = await hydrateRelatedReleases(db, filteredIds);
  const items = filteredIds
    .map((id) => {
      const row = hydrated.get(id);
      if (!row) return null;
      return { ...row, score: scoreById.get(id) ?? 0 };
    })
    .filter((x): x is RelatedReleaseItem => x !== null)
    .slice(0, limit);

  return c.json<RelatedReleasesResponse>({
    anchor,
    scope,
    degraded: false,
    items,
  });
});

async function hydrateRelatedReleases(
  db: D1Db,
  ids: string[],
): Promise<Map<string, RelatedReleaseItem>> {
  if (ids.length === 0) return new Map();
  const rows = await db.all<{
    id: string;
    title: string;
    version: string | null;
    url: string | null;
    publishedAt: string | null;
    summary: string;
    sourceId: string;
    sourceSlug: string;
    sourceName: string;
    orgSlug: string | null;
  }>(sql`
    SELECT r.id as id,
           r.title as title,
           r.version as version,
           r.url as url,
           r.published_at as publishedAt,
           COALESCE(r.content_summary, SUBSTR(r.content, 1, 200)) as summary,
           s.id as sourceId,
           s.slug as sourceSlug,
           s.name as sourceName,
           o.slug as orgSlug
    FROM releases r
    JOIN sources s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    WHERE r.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
  `);
  const out = new Map<string, RelatedReleaseItem>();
  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      title: r.title,
      version: r.version,
      url: r.url,
      publishedAt: r.publishedAt,
      summary: r.summary,
      score: 0,
      source: { id: r.sourceId, slug: r.sourceSlug, name: r.sourceName },
      orgSlug: r.orgSlug,
    });
  }
  return out;
}

// ── GET /v1/related/sources ───────────────────────────────────────────

relatedRoutes.get("/related/sources", async (c) => {
  const raw = c.req.query("source") ?? "";
  if (!raw) {
    return c.json(
      { error: "bad_request", message: "Missing required query parameter: source" },
      400,
    );
  }
  const scope = parseScope(c.req.query("scope"));
  const limit = parseLimit(c.req.query("limit"));

  const db = createDb(c.env.DB);

  const [anchorSrc] = await db
    .select({ id: sources.id, orgId: sources.orgId })
    .from(sources)
    .where(sourceWhere(raw));
  if (!anchorSrc) {
    return c.json({ error: "not_found", message: "Source not found" }, 404);
  }
  const anchor = { id: anchorSrc.id };

  if (scope === "org" && !anchorSrc.orgId) {
    return c.json<RelatedSourcesResponse>({
      anchor,
      scope,
      degraded: false,
      items: [],
    });
  }

  const index = c.env.ENTITIES_INDEX;
  const vec = await getAnchorVector(asSharedIndex(index), anchorSrc.id);
  if (!vec) {
    return c.json<RelatedSourcesResponse>(
      degraded<{ items: RelatedSourceItem[] }>(
        anchor,
        scope,
        "anchor vector unavailable — source not yet embedded or Vectorize binding missing",
        { items: [] },
      ),
    );
  }

  // Over-fetch so org/product/source mingling + filtering leaves enough
  // source hits. Vectorize tags each entity row with `type` (see
  // `src/lib/embed-entities.ts#buildEntityMetadata`); we filter by that
  // so we don't have to pay for hits that can never hydrate as sources.
  const topK = (limit + 5) * 3;
  const filter: Record<string, unknown> = { type: "source" };
  if (scope === "org" && anchorSrc.orgId) filter.org_id = anchorSrc.orgId;

  let matches: Array<{ id: string; score: number }>;
  try {
    const res = await asSharedIndex(index).query(vec.values, {
      topK,
      returnMetadata: "none",
      filter,
    });
    matches = res.matches.map((m) => ({ id: m.id, score: m.score }));
  } catch (err) {
    return c.json<RelatedSourcesResponse>(
      degraded<{ items: RelatedSourceItem[] }>(
        anchor,
        scope,
        err instanceof Error ? err.message : String(err),
        { items: [] },
      ),
    );
  }

  const filteredIds = pickCandidates(matches, anchorSrc.id, limit, "src_");
  if (filteredIds.length === 0) {
    return c.json<RelatedSourcesResponse>({
      anchor,
      scope,
      degraded: false,
      items: [],
    });
  }

  const scoreById = new Map(matches.map((m) => [m.id, m.score]));
  const hydrated = await hydrateRelatedSources(db, filteredIds);
  const items = filteredIds
    .map((id) => {
      const row = hydrated.get(id);
      if (!row) return null;
      return { ...row, score: scoreById.get(id) ?? 0 };
    })
    .filter((x): x is RelatedSourceItem => x !== null)
    .slice(0, limit);

  return c.json<RelatedSourcesResponse>({
    anchor,
    scope,
    degraded: false,
    items,
  });
});

async function hydrateRelatedSources(
  db: D1Db,
  ids: string[],
): Promise<Map<string, RelatedSourceItem>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      name: sources.name,
      orgSlug: organizations.slug,
      orgName: organizations.name,
      orgCategory: organizations.category,
    })
    .from(sources)
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .where(
      and(
        inArray(sources.id, ids),
        // Hidden sources never leak into related rails.
        sql`(${sources.isHidden} = 0 OR ${sources.isHidden} IS NULL)`,
      ),
    );

  // One rollup per source: release count + latest published date. We issue
  // a single GROUP BY instead of N subqueries to stay inside D1's CPU budget.
  const aggRows = await db.all<{
    sourceId: string;
    n: number;
    latestDate: string | null;
  }>(sql`
    SELECT source_id as sourceId,
           COUNT(*) as n,
           MAX(published_at) as latestDate
    FROM releases
    WHERE source_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      AND (suppressed IS NULL OR suppressed = 0)
    GROUP BY source_id
  `);
  const aggById = new Map(aggRows.map((r) => [r.sourceId, r]));

  const out = new Map<string, RelatedSourceItem>();
  for (const r of rows) {
    const agg = aggById.get(r.id);
    out.set(r.id, {
      id: r.id,
      slug: r.slug,
      name: r.name,
      category: r.orgCategory,
      score: 0,
      orgSlug: r.orgSlug,
      orgName: r.orgName,
      releaseCount: Number(agg?.n ?? 0),
      latestDate: agg?.latestDate ?? null,
    });
  }
  return out;
}
