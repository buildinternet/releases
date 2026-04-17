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
import { sources, organizations, releases } from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import { sourceWhere } from "../utils.js";
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
  score: number;
  source: { id: string; slug: string; name: string; orgSlug: string | null; orgName: string | null };
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
  releaseCount: number;
  latestDate: string | null;
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

  const index = c.env.RELEASES_INDEX as unknown as ReadOnlyVectorizeIndex | undefined;
  if (!index || typeof index.getByIds !== "function") {
    console.error("[related/releases] RELEASES_INDEX binding unavailable or missing getByIds");
    return c.json(degraded("RELEASES_INDEX unavailable"));
  }

  const db = createDb(c.env.DB);

  // Resolve the anchor release — we need its orgId for scope=org and we
  // also want to 404 on a bogus id rather than bill an embedding call.
  const [anchor] = await db
    .select({
      id: releases.id,
      sourceId: releases.sourceId,
      orgId: sources.orgId,
    })
    .from(releases)
    .innerJoin(sources, eq(sources.id, releases.sourceId))
    .where(eq(releases.id, anchorId));
  if (!anchor) {
    return c.json({ error: "not_found", message: "Release not found" }, 404);
  }

  let anchorVector: number[] | null = null;
  try {
    const rows = await index.getByIds([anchor.id]);
    anchorVector = rows[0]?.values ?? null;
  } catch (err) {
    console.error(`[related/releases] getByIds failed for ${anchor.id}:`, err);
    return c.json(degraded(err instanceof Error ? err.message : String(err)));
  }
  if (!anchorVector || anchorVector.length === 0) {
    // Anchor hasn't been embedded yet — not an error, just no neighbors.
    return c.json({ degraded: true as const, degradedReason: "anchor not embedded", items: [] });
  }

  // Over-fetch so we can drop the anchor + any hidden/suppressed rows and
  // still hit `limit`.
  const topK = limit + 5;
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
    console.error(`[related/releases] query failed for ${anchor.id} scope=${scope}:`, err);
    return c.json(degraded(err instanceof Error ? err.message : String(err)));
  }

  const neighborIds = matches.map((m) => m.id).filter((id) => id !== anchor.id);
  if (neighborIds.length === 0) {
    return c.json({ scope, items: [] as RelatedReleaseItem[] });
  }

  const items = await hydrateReleaseNeighbors(db, matches, anchor.id, limit);
  return c.json({ scope, items });
});

async function hydrateReleaseNeighbors(
  db: D1Db,
  matches: Array<{ id: string; score: number }>,
  anchorId: string,
  limit: number,
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
           COALESCE(r.content_summary, SUBSTR(r.content, 1, 300)) as summary,
           s.id as sourceId,
           s.slug as sourceSlug,
           s.name as sourceName,
           o.slug as orgSlug,
           o.name as orgName
    FROM releases r
    JOIN sources s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    WHERE r.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      AND (r.suppressed IS NULL OR r.suppressed = 0)
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
    console.error("[related/sources] ENTITIES_INDEX binding unavailable or missing getByIds");
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
    .where(sourceWhere(anchorParam));
  if (!anchor) {
    return c.json({ error: "not_found", message: "Source not found" }, 404);
  }

  let anchorVector: number[] | null = null;
  try {
    const rows = await index.getByIds([anchor.id]);
    anchorVector = rows[0]?.values ?? null;
  } catch (err) {
    console.error(`[related/sources] getByIds failed for ${anchor.id}:`, err);
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

  const topK = limit + 5;
  let matches: Array<{ id: string; score: number }>;
  try {
    const res = await index.query(anchorVector, {
      topK,
      returnMetadata: "none",
      filter,
    });
    matches = res.matches.map((m) => ({ id: m.id, score: m.score }));
  } catch (err) {
    console.error(`[related/sources] query failed for ${anchor.id} scope=${scope}:`, err);
    return c.json(degraded(err instanceof Error ? err.message : String(err)));
  }

  const neighborIds = matches.map((m) => m.id).filter((id) => id !== anchor.id);
  if (neighborIds.length === 0) {
    return c.json({ scope, items: [] as RelatedSourceItem[] });
  }

  const rows = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      name: sources.name,
      type: sources.type,
      url: sources.url,
      orgId: sources.orgId,
      isHidden: sources.isHidden,
    })
    .from(sources)
    .where(inArray(sources.id, neighborIds));

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
            id: organizations.id,
            slug: organizations.slug,
            name: organizations.name,
          })
          .from(organizations)
          .where(inArray(organizations.id, orgIds))
      : [];
  const orgById = new Map<string, { slug: string; name: string }>();
  for (const o of orgRows) orgById.set(o.id, { slug: o.slug, name: o.name });

  // Release counts + latest date per neighbor source — one aggregate query.
  const visibleIds = [...visibleById.keys()];
  const statsRows: Array<{ sourceId: string; n: number; latest: string | null }> =
    visibleIds.length > 0
      ? await db.all<{ sourceId: string; n: number; latest: string | null }>(sql`
          SELECT r.source_id as sourceId,
                 COUNT(*) as n,
                 MAX(r.published_at) as latest
          FROM releases r
          WHERE r.source_id IN (${sql.join(visibleIds.map((id) => sql`${id}`), sql`, `)})
            AND (r.suppressed IS NULL OR r.suppressed = 0)
          GROUP BY r.source_id
        `)
      : [];
  const statsById = new Map<string, { n: number; latest: string | null }>();
  for (const row of statsRows) statsById.set(row.sourceId, { n: row.n, latest: row.latest });

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
      releaseCount: stats?.n ?? 0,
      latestDate: stats?.latest ?? null,
    });
    if (items.length >= limit) break;
  }

  return c.json({ scope, items });
});

