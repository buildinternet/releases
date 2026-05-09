/**
 * MCP-worker hybrid search helper. Mirrors
 * `workers/api/src/lib/search-hybrid.ts` — same contract, same graceful
 * degradation, but inlines its own FTS query so the MCP worker doesn't
 * have to import across worker directory boundaries. If you fix a bug
 * here, fix it in the api worker copy too.
 */

import { logEvent } from "@releases/lib/log-event";
import { sql, inArray } from "drizzle-orm";
import { toFtsMatchQuery } from "@buildinternet/releases-core/fts";
import {
  sourcesActive,
  organizationsActive,
  productsActive,
  sourceChangelogFiles,
} from "@buildinternet/releases-core/schema";
import {
  hybridSearch,
  type VectorizeIndex as HybridVectorizeIndex,
} from "@releases/search/vector-search.js";
import { embedBatch, VOYAGE_OUTPUT_DIMENSION } from "@releases/search/embeddings.js";
import { withEmbedCache, type EmbedCacheBinding } from "@releases/search/embedding-cache.js";
import { buildEmbedConfig } from "./embed-config.js";
import type { ReleaseType } from "@buildinternet/releases-api-types";
import type { D1Db } from "../db.js";

// `@releases/search/embeddings.js` touches `process.env` at module scope;
// we shim `process` in `src/stubs/process.d.ts` so the MCP worker's
// tsconfig type-checks without node/bun type packages. At runtime the
// Workers runtime exposes `process.env = {}` and the embeddings module
// never reaches for real values because we pass an explicit
// `EmbeddingConfig` override.

type SecretBinding = { get(): Promise<string> };

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
};

export interface HybridSearchEnv {
  DB: D1Database;
  RELEASES_INDEX?: ReadOnlyVectorizeIndex;
  ENTITIES_INDEX?: ReadOnlyVectorizeIndex;
  CHANGELOG_CHUNKS_INDEX?: ReadOnlyVectorizeIndex;
  EMBEDDING_PROVIDER?: string;
  VOYAGE_API_KEY?: SecretBinding;
  OPENAI_API_KEY?: SecretBinding;
  /** Optional KV binding caching one-shot query embeddings. Absent → no-op. */
  EMBED_CACHE?: EmbedCacheBinding;
}

export interface HybridSearchOpts {
  waitUntil?: (p: Promise<unknown>) => void;
}

export type HybridMode = "lexical" | "semantic" | "hybrid";

export interface HybridReleaseHit {
  kind: "release";
  score: number;
  release: {
    id: string;
    title: string;
    version: string | null;
    url: string | null;
    publishedAt: string | null;
    summary: string;
    titleGenerated: string | null;
    titleShort: string | null;
    source: { id: string; slug: string; name: string };
    orgSlug: string | null;
    /** Release type — "feature" (default) or "rollup". */
    type: ReleaseType;
  };
}

export interface HybridChunkHit {
  kind: "changelog_chunk";
  score: number;
  chunk: {
    id: string;
    vectorId: string;
    source: { id: string; slug: string; name: string };
    offset: number;
    length: number;
    snippet: string;
    file_path: string;
    heading: string | null;
  };
}

export type HybridHit = HybridReleaseHit | HybridChunkHit;

export interface HybridSearchResponse {
  mode: HybridMode;
  degraded: boolean;
  degradedReason?: string;
  hits: HybridHit[];
}

// ── Local FTS query ──────────────────────────────────────────────────

async function ftsReleaseIds(
  db: D1Db,
  query: string,
  limit: number,
  opts: { includeCoverage?: boolean } = {},
): Promise<string[]> {
  try {
    const rows = await db.all<{ id: string }>(sql`
      SELECT r.id as id
      FROM releases_fts
      JOIN releases r ON r.rowid = releases_fts.rowid
      JOIN sources_active s ON s.id = r.source_id
      WHERE releases_fts MATCH ${toFtsMatchQuery(query)}
        AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
        AND (r.suppressed IS NULL OR r.suppressed = 0)
        ${opts.includeCoverage ? sql`` : sql`AND r.id IN (SELECT id FROM releases_visible)`}
      ORDER BY rank LIMIT ${limit}
    `);
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

// ── Embedding resolution ──────────────────────────────────────────────

async function buildEmbedder(
  env: HybridSearchEnv,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<((text: string) => Promise<number[]>) | null> {
  const cfg = await buildEmbedConfig(env);
  if (!cfg) return null;
  const raw = async (text: string) => {
    const result = await embedBatch([text], cfg);
    const v = result.vectors[0];
    if (!v) throw new Error("embedBatch returned no vectors");
    return v;
  };
  return withEmbedCache(
    raw,
    env.EMBED_CACHE,
    { provider: cfg.provider, model: cfg.model, dim: VOYAGE_OUTPUT_DIMENSION },
    waitUntil,
  );
}

// ── Hydration ─────────────────────────────────────────────────────────

interface RawReleaseRow {
  id: string;
  title: string;
  version: string | null;
  url: string | null;
  publishedAt: string | null;
  summary: string;
  titleGenerated: string | null;
  titleShort: string | null;
  sourceId: string;
  sourceSlug: string;
  sourceName: string;
  orgSlug: string | null;
  /** Release type — "feature" (default) or "rollup". */
  type: ReleaseType;
}

async function hydrateReleases(
  db: D1Db,
  ids: string[],
  opts: { includeCoverage?: boolean } = {},
): Promise<Map<string, RawReleaseRow>> {
  if (ids.length === 0) return new Map();
  const releasesTable = opts.includeCoverage ? sql`releases` : sql`releases_visible`;
  const rows = await db.all<RawReleaseRow>(sql`
    SELECT r.id as id,
           r.title as title,
           r.version as version,
           r.url as url,
           r.published_at as publishedAt,
           COALESCE(r.summary, SUBSTR(r.content, 1, 300)) as summary,
           r.title_generated as titleGenerated,
           r.title_short as titleShort,
           r.type as type,
           s.id as sourceId,
           s.slug as sourceSlug,
           s.name as sourceName,
           o.slug as orgSlug
    FROM ${releasesTable} r
    JOIN sources_active s ON s.id = r.source_id
    LEFT JOIN organizations_active o ON o.id = s.org_id
    WHERE r.id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (r.suppressed IS NULL OR r.suppressed = 0)
  `);
  const map = new Map<string, RawReleaseRow>();
  for (const row of rows) map.set(row.id, row);
  return map;
}

interface RawChunkRow {
  id: string;
  vectorId: string;
  offset: number;
  length: number;
  heading: string | null;
  fileId: string;
  filePath: string;
  sourceId: string;
  sourceSlug: string;
  sourceName: string;
}

/**
 * Hydrate chunk hits by vector_id. Batches file reads so N chunks in the
 * same file only trigger one content load.
 */
async function hydrateChunks(
  db: D1Db,
  vectorIds: string[],
): Promise<Map<string, HybridChunkHit["chunk"]>> {
  if (vectorIds.length === 0) return new Map();

  const chunkRows = await db.all<RawChunkRow>(sql`
    SELECT scc.id as id,
           scc.vector_id as vectorId,
           scc.offset as offset,
           scc.length as length,
           scc.heading as heading,
           scf.id as fileId,
           scf.path as filePath,
           s.id as sourceId,
           s.slug as sourceSlug,
           s.name as sourceName
    FROM source_changelog_chunks scc
    JOIN source_changelog_files scf ON scf.id = scc.source_changelog_file_id
    JOIN sources_active s ON s.id = scc.source_id
    WHERE scc.vector_id IN (${sql.join(
      vectorIds.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
  `);

  if (chunkRows.length === 0) return new Map();

  const uniqueFileIds = [...new Set(chunkRows.map((r) => r.fileId))];
  const fileRows = await db
    .select({ id: sourceChangelogFiles.id, content: sourceChangelogFiles.content })
    .from(sourceChangelogFiles)
    .where(inArray(sourceChangelogFiles.id, uniqueFileIds));
  const fileContent = new Map<string, string>();
  for (const f of fileRows) fileContent.set(f.id, f.content);

  const out = new Map<string, HybridChunkHit["chunk"]>();
  for (const row of chunkRows) {
    const content = fileContent.get(row.fileId) ?? "";
    const rawSnippet = content.slice(row.offset, row.offset + row.length);
    const snippet = rawSnippet.length > 2000 ? `${rawSnippet.slice(0, 2000)}…` : rawSnippet;
    out.set(row.vectorId, {
      id: row.id,
      vectorId: row.vectorId,
      source: { id: row.sourceId, slug: row.sourceSlug, name: row.sourceName },
      offset: row.offset,
      length: row.length,
      snippet,
      file_path: row.filePath,
      heading: row.heading,
    });
  }
  return out;
}

// ── Public API ────────────────────────────────────────────────────────

export interface RunHybridSearchParams {
  query: string;
  topK?: number;
  mode?: HybridMode;
  sourceId?: string;
  orgSourceIds?: string[];
  type?: "feature" | "rollup";
  includeCoverage?: boolean;
}

export async function runHybridSearch(
  env: HybridSearchEnv,
  db: D1Db,
  params: RunHybridSearchParams,
  opts: HybridSearchOpts = {},
): Promise<HybridSearchResponse> {
  const topK = params.topK ?? 20;
  const requestedMode: HybridMode = params.mode ?? "hybrid";

  async function lexicalResponse(degradedReason?: string): Promise<HybridSearchResponse> {
    const ids = await ftsReleaseIds(db, params.query, topK * 3, {
      includeCoverage: params.includeCoverage,
    });
    const hits = await buildReleaseHits(
      db,
      ids.map((id, i) => ({ id, score: 1 / (i + 1) })),
      params,
    );
    return {
      mode: degradedReason ? requestedMode : "lexical",
      degraded: degradedReason !== undefined,
      ...(degradedReason ? { degradedReason } : {}),
      hits: hits.slice(0, topK),
    };
  }

  if (requestedMode === "lexical") return lexicalResponse();

  const embedder = await buildEmbedder(env, opts.waitUntil);
  const hasVectorize = !!env.RELEASES_INDEX && !!env.CHANGELOG_CHUNKS_INDEX && !!embedder;

  if (!hasVectorize) {
    return lexicalResponse(
      !embedder ? "embedding provider unavailable or misconfigured" : "vectorize bindings missing",
    );
  }

  const vectorIndexes = [
    {
      name: "releases-v1",
      kind: "release",
      index: env.RELEASES_INDEX! as unknown as HybridVectorizeIndex,
    },
    {
      name: "changelog-chunks-v1",
      kind: "changelog_chunk",
      index: env.CHANGELOG_CHUNKS_INDEX! as unknown as HybridVectorizeIndex,
    },
  ];

  const ftsSearchFn =
    requestedMode === "semantic"
      ? async () => [] as { id: string }[]
      : async (q: string, limit: number) => {
          const ids = await ftsReleaseIds(db, q, limit, {
            includeCoverage: params.includeCoverage,
          });
          return ids.map((id) => ({ id }));
        };

  let fused: Awaited<ReturnType<typeof hybridSearch>>;
  try {
    fused = await hybridSearch({
      query: params.query,
      topK: topK * 3,
      ftsSearch: ftsSearchFn,
      vectorIndexes,
      embed: embedder,
    });
  } catch (err) {
    logEvent("warn", { component: "mcp-search-hybrid", event: "degraded-to-fts", err });
    return lexicalResponse(err instanceof Error ? err.message : String(err));
  }

  const releaseEntries = fused.filter((r) => r.kind === "release");
  const chunkEntries = fused.filter((r) => r.kind === "changelog_chunk");

  const [releaseHits, chunkMap] = await Promise.all([
    buildReleaseHits(db, releaseEntries, params),
    hydrateChunks(
      db,
      chunkEntries.map((e) => e.id),
    ),
  ]);

  const hitsById = new Map<string, HybridHit>();
  for (const h of releaseHits) hitsById.set(h.release.id, h);

  const merged: HybridHit[] = [];
  for (const entry of fused) {
    if (entry.kind === "release") {
      const rh = hitsById.get(entry.id);
      if (rh) merged.push(rh);
    } else if (entry.kind === "changelog_chunk") {
      const c = chunkMap.get(entry.id);
      if (c) merged.push({ kind: "changelog_chunk", score: entry.score, chunk: c });
    }
  }

  return {
    mode: requestedMode,
    degraded: false,
    hits: merged.slice(0, topK),
  };
}

async function buildReleaseHits(
  db: D1Db,
  entries: Array<{ id: string; score: number }>,
  params: RunHybridSearchParams,
): Promise<HybridReleaseHit[]> {
  if (entries.length === 0) return [];
  const map = await hydrateReleases(
    db,
    entries.map((e) => e.id),
    { includeCoverage: params.includeCoverage },
  );
  const out: HybridReleaseHit[] = [];
  for (const entry of entries) {
    const row = map.get(entry.id);
    if (!row) continue;
    if (params.sourceId && row.sourceId !== params.sourceId) continue;
    if (params.orgSourceIds && !params.orgSourceIds.includes(row.sourceId)) continue;
    out.push({
      kind: "release",
      score: entry.score,
      release: {
        id: row.id,
        title: row.title,
        version: row.version,
        url: row.url,
        publishedAt: row.publishedAt,
        summary: row.summary,
        titleGenerated: row.titleGenerated,
        titleShort: row.titleShort,
        source: { id: row.sourceId, slug: row.sourceSlug, name: row.sourceName },
        orgSlug: row.orgSlug,
        type: row.type,
      },
    });
  }
  return out;
}

// ── Registry (entity) search ──────────────────────────────────────────

export type EntityKind = "org" | "product" | "source";

export interface RegistryHit {
  kind: EntityKind;
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  score: number;
}

export interface RegistrySearchResponse {
  degraded: boolean;
  degradedReason?: string;
  hits: RegistryHit[];
}

export async function runRegistrySearch(
  env: HybridSearchEnv,
  db: D1Db,
  params: { query: string; kind?: EntityKind; limit?: number },
  opts: HybridSearchOpts = {},
): Promise<RegistrySearchResponse> {
  const limit = params.limit ?? 20;

  const embedder = await buildEmbedder(env, opts.waitUntil);
  if (!env.ENTITIES_INDEX || !embedder) {
    return {
      degraded: true,
      degradedReason: !embedder
        ? "embedding provider unavailable"
        : "ENTITIES_INDEX binding missing",
      hits: [],
    };
  }

  let matches: Array<{ id: string; score: number }>;
  try {
    const vec = await embedder(params.query);
    const res = await env.ENTITIES_INDEX.query(vec, {
      topK: limit * 3,
      returnMetadata: "none",
    });
    matches = res.matches.map((m) => ({ id: m.id, score: m.score }));
  } catch (err) {
    return {
      degraded: true,
      degradedReason: err instanceof Error ? err.message : String(err),
      hits: [],
    };
  }

  const orgIds: string[] = [];
  const productIds: string[] = [];
  const sourceIds: string[] = [];
  for (const m of matches) {
    if (m.id.startsWith("org_")) orgIds.push(m.id);
    else if (m.id.startsWith("prod_")) productIds.push(m.id);
    else if (m.id.startsWith("src_")) sourceIds.push(m.id);
  }

  const wantsKind = (k: EntityKind) => !params.kind || params.kind === k;
  const shouldFetchOrgs = wantsKind("org") && orgIds.length > 0;
  const shouldFetchProducts = wantsKind("product") && productIds.length > 0;
  const shouldFetchSources = wantsKind("source") && sourceIds.length > 0;

  const [orgRows, productRows, sourceRows] = await Promise.all([
    shouldFetchOrgs
      ? db
          .select({
            id: organizationsActive.id,
            slug: organizationsActive.slug,
            name: organizationsActive.name,
            description: organizationsActive.description,
            category: organizationsActive.category,
          })
          .from(organizationsActive)
          .where(inArray(organizationsActive.id, orgIds))
      : [],
    shouldFetchProducts
      ? db
          .select({
            id: productsActive.id,
            slug: productsActive.slug,
            name: productsActive.name,
            description: productsActive.description,
            category: productsActive.category,
          })
          .from(productsActive)
          .where(inArray(productsActive.id, productIds))
      : [],
    shouldFetchSources
      ? db
          .select({
            id: sourcesActive.id,
            slug: sourcesActive.slug,
            name: sourcesActive.name,
          })
          .from(sourcesActive)
          .where(inArray(sourcesActive.id, sourceIds))
      : [],
  ]);

  const byId = new Map<string, RegistryHit>();
  for (const o of orgRows) {
    byId.set(o.id, {
      kind: "org",
      id: o.id,
      slug: o.slug,
      name: o.name,
      description: o.description,
      category: o.category,
      score: 0,
    });
  }
  for (const p of productRows) {
    byId.set(p.id, {
      kind: "product",
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      category: p.category,
      score: 0,
    });
  }
  for (const s of sourceRows) {
    byId.set(s.id, {
      kind: "source",
      id: s.id,
      slug: s.slug,
      name: s.name,
      description: null,
      category: null,
      score: 0,
    });
  }

  const hits: RegistryHit[] = [];
  for (const m of matches) {
    const hit = byId.get(m.id);
    if (!hit) continue;
    hit.score = m.score;
    hits.push(hit);
    if (hits.length >= limit) break;
  }

  return { degraded: false, hits };
}
