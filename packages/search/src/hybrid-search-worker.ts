/**
 * Worker-side hybrid search helper. Single source of truth for the API
 * and MCP workers — both `workers/api/src/lib/search-hybrid.ts` and
 * `workers/mcp/src/lib/search-hybrid.ts` are thin re-export adapters
 * that wire in their local `buildEmbedConfig`.
 *
 * Wraps `hybridSearch` from `./vector-search.js` with closures over the
 * D1 binding (for FTS), the Vectorize bindings (for vectors), and the
 * embedding config supplied by the caller. After `hybridSearch` returns
 * ranked IDs, this module hydrates them back into D1 rows so the caller
 * never sees raw Vectorize metadata.
 *
 * Graceful degradation is baked in: if the Vectorize bindings are missing
 * or the embedding call fails, the hybrid path collapses to pure FTS and
 * the caller is signalled via the `degraded` field on the response.
 */

import { sql, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  sourcesActive,
  organizationsActive,
  productsActive,
  sourceChangelogFiles,
  collections,
  collectionMembers,
  organizationsPublic,
} from "@buildinternet/releases-core/schema";
import * as schema from "@buildinternet/releases-core/schema";
import { getEntityType } from "@buildinternet/releases-core/id";
import { toFtsMatchQuery } from "@buildinternet/releases-core/fts";
import { chunkArray } from "@buildinternet/releases-core/d1-limits";
import { COVERAGE_COUNT_EXPR } from "@releases/core-internal/release-coverage-sql";
import { logEvent } from "@releases/lib/log-event";
import type { ReleaseType } from "@buildinternet/releases-api-types";
import { hybridSearch, type VectorizeIndex as HybridVectorizeIndex } from "./vector-search.js";
import {
  embedBatch,
  getEmbedDim,
  type EmbeddingConfig,
  type EmbeddingProvider,
} from "./embeddings.js";
import { withEmbedCache, type EmbedCacheBinding } from "./embedding-cache.js";
import { isEmptyReleaseContent } from "./content-quality.js";

// Max ids per `IN (...)` clause. D1's hard cap is 100 binds per prepared
// statement (per `AGENTS.md`); 90 leaves headroom for any other binds the
// statement carries today and any added later.
const D1_IN_CHUNK = 90;

// Local D1 db type — same shape as workers/api and workers/mcp's `D1Db`
// (both compute `ReturnType<typeof drizzle<typeof schema>>`). Re-deriving
// here keeps the shared module independent of either worker.
export type WorkerD1Db = ReturnType<typeof drizzle<typeof schema>>;

type SecretBinding = { get(): Promise<string> };

/**
 * Loose index type — we only care about `.query()` in the hybrid path.
 * Using the workers-types `VectorizeIndex` would force all callers to
 * satisfy the stricter `VectorizeVectorMetadata` shape on `.upsert()`,
 * which the api worker's sources route already struggles with. We coerce
 * at the hybridSearch boundary instead.
 */
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

/** Env subset consumed by `buildEmbedConfig` resolvers. */
export interface EmbedConfigEnv {
  EMBEDDING_PROVIDER?: string;
  VOYAGE_API_KEY?: SecretBinding;
  OPENAI_API_KEY?: SecretBinding;
}

/** Shape returned by a worker's `buildEmbedConfig` — provider + model resolved. */
export type ResolvedEmbedConfig = EmbeddingConfig & {
  provider: EmbeddingProvider;
  model: string;
};

export type BuildEmbedConfig = (env: EmbedConfigEnv) => Promise<ResolvedEmbedConfig | null>;

export interface HybridSearchEnv extends EmbedConfigEnv {
  RELEASES_INDEX?: ReadOnlyVectorizeIndex;
  ENTITIES_INDEX?: ReadOnlyVectorizeIndex;
  CHANGELOG_CHUNKS_INDEX?: ReadOnlyVectorizeIndex;
  /** Optional KV binding caching one-shot query embeddings. Absent → no-op. */
  EMBED_CACHE?: EmbedCacheBinding;
  /** Recency half-life in days. Default 120. Bounded [1, 3650] at parse time. */
  SEARCH_RECENCY_HALFLIFE_DAYS?: string;
  /** Recency boost peak (age <= 30d). Default 1.5. Bounded [1.0, 5.0]. */
  SEARCH_RECENCY_BOOST_30D?: string;
  /** Recency boost knee (age = 90d / Option A 30-90d). Default 1.2. Bounded [1.0, 5.0]. */
  SEARCH_RECENCY_BOOST_90D?: string;
}

const DEFAULT_HALFLIFE_DAYS = 120;
const MIN_HALFLIFE_DAYS = 1;
const MAX_HALFLIFE_DAYS = 3650;

const DEFAULT_BOOST_30D = 1.5;
const DEFAULT_BOOST_90D = 1.2;
const MIN_BOOST = 1.0;
const MAX_BOOST = 5.0;

const BOOST_RAMP_START_MS = 30 * 86_400_000;
const BOOST_RAMP_END_MS = 90 * 86_400_000;

function parseHalfLifeDays(raw: string | undefined): number {
  if (!raw) return DEFAULT_HALFLIFE_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_HALFLIFE_DAYS;
  return Math.min(MAX_HALFLIFE_DAYS, Math.max(MIN_HALFLIFE_DAYS, n));
}

function parseBoost(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_BOOST, Math.max(MIN_BOOST, n));
}

/**
 * Piecewise recency boost (see docs/architecture/semantic-search.md for the
 * curve and the multiplier table). The `MIN_BOOST = 1.0` parse-time floor is
 * load-bearing — this multiplier must never demote recent content, only lift
 * it. Exported for unit tests so the curve can be pinned without a full
 * hybridSearch fixture.
 */
export function recencyBoost(ageMs: number, boost30d: number, boost90d: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= BOOST_RAMP_START_MS) return boost30d;
  if (ageMs >= BOOST_RAMP_END_MS) return 1;
  const t = (ageMs - BOOST_RAMP_START_MS) / (BOOST_RAMP_END_MS - BOOST_RAMP_START_MS);
  return boost30d + (boost90d - boost30d) * t;
}

/**
 * Per-call plumbing. `waitUntil` — when provided — lets the embedding
 * cache fire KV writes without blocking the response.
 *
 * `embedConfig` — when provided (including `null` for "no provider
 * configured") — skips the per-helper call to the worker's
 * `buildEmbedConfig` so multiple helpers share one Secrets Store read.
 */
export interface HybridSearchOpts {
  waitUntil?: (p: Promise<unknown>) => void;
  embedConfig?: ResolvedEmbedConfig | null;
}

interface InternalOpts extends HybridSearchOpts {
  buildEmbedConfig: BuildEmbedConfig;
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
    /**
     * Raw markdown body; media URLs still need MEDIA_ORIGIN rewriting.
     * Present only when `includeContent: true` was requested — list hits
     * default to summary + media only.
     */
    content?: string;
    /** JSON-encoded MediaItem[] or null — route parses + resolves r2Url. */
    media: string | null;
    source: {
      id: string;
      slug: string;
      name: string;
      type: string;
      /**
       * App Store platform + icon for `type: "appstore"` sources, null otherwise.
       * Lets the web search card render the compact app-update treatment. #1206
       */
      appStore: { platform: "ios" | "macos"; iconUrl: string | null } | null;
      /** Video provider tag for `type: "video"` sources, null otherwise. #video */
      video: { provider: "youtube" | "vimeo" | "wistia" } | null;
    };
    /** Owning product slug — null for orphan sources; powers product-aware byline links. */
    productSlug: string | null;
    orgSlug: string | null;
    orgName: string | null;
    /** Release type — "feature" (default) or "rollup". */
    type: ReleaseType;
    titleGenerated: string | null;
    titleShort: string | null;
    /** Number of demoted siblings rolling up via `release_coverage` (0 when standalone). */
    coverageCount: number;
  };
}

export interface HybridChunkHit {
  kind: "changelog_chunk";
  score: number;
  chunk: {
    id: string;
    vectorId: string;
    source: { id: string; slug: string; name: string };
    /** Parent org slug, if the source belongs to one. */
    orgSlug: string | null;
    orgName: string | null;
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

// ── FTS query ────────────────────────────────────────────────────────

/**
 * Inline FTS query returning release IDs only. Mirrors the filter shape
 * of `searchReleasesFts` in `./releases-fts.ts` (active sources,
 * unsuppressed, optional `releases_visible` join for the default
 * coverage-aware view) but skips the wider hydration since the hybrid
 * path re-hydrates after RRF. Kept as its own MATCH site (closed set —
 * see packages/core/src/fts.ts) rather than selecting full rows.
 */
async function ftsReleaseIds(
  db: WorkerD1Db,
  query: string,
  limit: number,
  opts: { includeCoverage?: boolean; kind?: string } = {},
): Promise<string[]> {
  try {
    const rows = await db.all<{ id: string }>(sql`
      SELECT r.id as id
      FROM releases_fts
      JOIN releases r ON r.rowid = releases_fts.rowid
      JOIN sources_active s ON s.id = r.source_id
      LEFT JOIN products_active p ON p.id = s.product_id
      WHERE releases_fts MATCH ${toFtsMatchQuery(query)}
        AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
        AND (r.suppressed IS NULL OR r.suppressed = 0)
        ${opts.includeCoverage ? sql`` : sql`AND r.id IN (SELECT id FROM releases_visible)`}
        ${opts.kind ? sql`AND COALESCE(s.kind, p.kind) = ${opts.kind}` : sql``}
      ORDER BY rank LIMIT ${limit}
    `);
    return rows.map((r) => r.id);
  } catch (err) {
    logEvent("warn", {
      component: "search-hybrid",
      event: "fts-query-failed",
      queryLen: query.length,
      err: err instanceof Error ? err : String(err),
    });
    return [];
  }
}

// ── Embedding resolution ──────────────────────────────────────────────

/**
 * Resolve the embedding config via the caller-supplied `buildEmbedConfig`
 * and return an `embed(text)` closure ready for `hybridSearch`. Returns
 * null when no provider is configured — the caller degrades to lexical
 * in that case.
 */
async function buildEmbedder(
  env: HybridSearchEnv,
  opts: InternalOpts,
): Promise<((text: string) => Promise<number[]>) | null> {
  const cfg = opts.embedConfig !== undefined ? opts.embedConfig : await opts.buildEmbedConfig(env);
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
    { provider: cfg.provider, model: cfg.model, dim: getEmbedDim(cfg.provider, cfg.model) },
    opts.waitUntil,
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
  /** Full body; only selected when `includeContent` is true. */
  content?: string | null;
  media: string | null;
  sourceId: string;
  sourceSlug: string;
  sourceName: string;
  sourceType: string;
  /** Raw source.metadata JSON — parsed for App Store icon/platform (#1206). */
  sourceMetadata: string | null;
  /** Source's own kind — used for COALESCE(sourceKind, productKind) filtering. */
  sourceKind: string | null;
  /** Parent product's kind — fallback when sourceKind is null. */
  productKind: string | null;
  /** Owning product's slug — null for orphan sources; powers product-aware byline links. */
  productSlug: string | null;
  orgSlug: string | null;
  orgName: string | null;
  /** Release type — "feature" (default) or "rollup". */
  type: ReleaseType;
  titleGenerated: string | null;
  titleShort: string | null;
  /** Number of demoted siblings rolling up via `release_coverage` (0 when standalone). */
  coverageCount: number;
}

async function hydrateReleases(
  db: WorkerD1Db,
  ids: string[],
  opts: { includeCoverage?: boolean; includeContent?: boolean } = {},
): Promise<Map<string, RawReleaseRow>> {
  if (ids.length === 0) return new Map();
  const releasesTable = opts.includeCoverage ? sql`releases` : sql`releases_visible`;
  // Full body is heavy (multi-KB markdown per hit); only SELECT when the
  // caller opted in. Summary already COALESCE-falls back to a content prefix.
  const contentSelect = opts.includeContent ? sql`r.content as content,` : sql``;
  // Chunked at D1_IN_CHUNK to stay under D1's 100-bind cap.
  const results = await Promise.all(
    chunkArray(ids, D1_IN_CHUNK).map((batch) =>
      db.all<RawReleaseRow>(sql`
        SELECT r.id as id,
               r.title as title,
               r.version as version,
               r.url as url,
               r.published_at as publishedAt,
               COALESCE(r.summary, SUBSTR(r.content, 1, 300)) as summary,
               r.title_generated as titleGenerated,
               r.title_short as titleShort,
               ${contentSelect}
               r.media as media,
               r.type as type,
               s.id as sourceId,
               s.slug as sourceSlug,
               s.name as sourceName,
               s.type as sourceType,
               s.metadata as sourceMetadata,
               s.kind as sourceKind,
               p.kind as productKind,
               p.slug as productSlug,
               o.slug as orgSlug,
               o.name as orgName,
               ${sql.raw(COVERAGE_COUNT_EXPR)} as coverageCount
        FROM ${releasesTable} r
        JOIN sources_active s ON s.id = r.source_id
        LEFT JOIN products_active p ON p.id = s.product_id
        LEFT JOIN organizations_active o ON o.id = s.org_id
        WHERE r.id IN (${sql.join(
          batch.map((id) => sql`${id}`),
          sql`, `,
        )})
          AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
          AND (r.suppressed IS NULL OR r.suppressed = 0)
      `),
    ),
  );
  const map = new Map<string, RawReleaseRow>();
  for (const row of results.flat()) map.set(row.id, row);
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
  orgSlug: string | null;
  orgName: string | null;
}

/**
 * Hydrate chunk hits by Vectorize ID. Each row carries enough info to
 * slice the snippet out of the parent file's `content` column — but we
 * batch the file reads separately so many chunks in the same file only
 * fetch the content once. We deliberately avoid joining `content` into
 * the chunk row because D1 flattens every matched row and file content
 * can be ~1MB.
 */
async function hydrateChunks(
  db: WorkerD1Db,
  vectorIds: string[],
): Promise<Map<string, HybridChunkHit["chunk"]>> {
  if (vectorIds.length === 0) return new Map();

  // Chunked at D1_IN_CHUNK to stay under D1's 100-bind cap.
  const chunkRowResults = await Promise.all(
    chunkArray(vectorIds, D1_IN_CHUNK).map((batch) =>
      db.all<RawChunkRow>(sql`
        SELECT scc.id as id,
               scc.vector_id as vectorId,
               scc.offset as offset,
               scc.length as length,
               scc.heading as heading,
               scf.id as fileId,
               scf.path as filePath,
               s.id as sourceId,
               s.slug as sourceSlug,
               s.name as sourceName,
               o.slug as orgSlug,
               o.name as orgName
        FROM source_changelog_chunks scc
        JOIN source_changelog_files scf ON scf.id = scc.source_changelog_file_id
        JOIN sources_active s ON s.id = scc.source_id
        LEFT JOIN organizations_active o ON o.id = s.org_id
        WHERE scc.vector_id IN (${sql.join(
          batch.map((id) => sql`${id}`),
          sql`, `,
        )})
          AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
      `),
    ),
  );
  const chunkRows = chunkRowResults.flat();

  if (chunkRows.length === 0) return new Map();

  // Batch-load file contents once per unique file. Chunked the same way —
  // a search returning many distinct files plus topK*3 can push past the
  // 100-bind cap here too.
  const uniqueFileIds = [...new Set(chunkRows.map((r) => r.fileId))];
  const fileRowsResults = await Promise.all(
    chunkArray(uniqueFileIds, D1_IN_CHUNK).map((batch) =>
      db
        .select({ id: sourceChangelogFiles.id, content: sourceChangelogFiles.content })
        .from(sourceChangelogFiles)
        .where(inArray(sourceChangelogFiles.id, batch)),
    ),
  );
  const fileRows = fileRowsResults.flat();
  const fileContent = new Map<string, string>();
  for (const f of fileRows) fileContent.set(f.id, f.content);

  const out = new Map<string, HybridChunkHit["chunk"]>();
  for (const row of chunkRows) {
    const content = fileContent.get(row.fileId) ?? "";
    // Judgment call: cap snippets at 2000 chars to keep MCP tool output
    // bounded. Real chunks are typically ~800–1600 chars; rollups can
    // overshoot. Callers that need the full slice can reach for
    // get_catalog_entry with changelog_offset+changelog_limit.
    const rawSnippet = content.slice(row.offset, row.offset + row.length);
    const snippet = rawSnippet.length > 2000 ? `${rawSnippet.slice(0, 2000)}…` : rawSnippet;
    out.set(row.vectorId, {
      id: row.id,
      vectorId: row.vectorId,
      source: { id: row.sourceId, slug: row.sourceSlug, name: row.sourceName },
      orgSlug: row.orgSlug,
      orgName: row.orgName,
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
  /**
   * When true, hydrate full markdown `content` onto each release hit.
   * Default false — list surfaces use `summary` + `media`; full body is
   * `GET /v1/releases/:id` (or `?include_content=true` on `/v1/search`).
   */
  includeContent?: boolean;
  /**
   * Filter by resolved entity kind: COALESCE(source.kind, product.kind).
   * Release hits where neither the source nor the parent product match are
   * excluded. Catalog hits on /v1/search filter on the row's own kind — no
   * inheritance — but that path lives in the route, not here.
   */
  kind?: string;
  /**
   * Time-window bounds on `published_at`, as canonical ISO timestamps (already
   * resolved from any relative shorthand by the caller). `since` keeps hits at
   * or after the bound; `until` keeps hits at or before it. Releases with a
   * NULL `published_at` are excluded whenever either bound is set — an undated
   * release can't be placed in a window.
   */
  since?: string;
  until?: string;
}

/**
 * Run a hybrid search over releases + changelog chunks.
 *
 * Filtering note: we apply `sourceId` / `orgSourceIds` / `type` / `kind` /
 * `since` / `until` as a post-filter after hydration (the `kind` filter also
 * narrows the FTS candidate set up front). Vectorize metadata filters would be
 * preferable here but would require the indexer to tag every vector with these
 * fields — out of scope for this task. A narrow `kind` value or a tight time
 * window can cause the returned hit count to fall well below `topK` even when
 * more matches exist past the `topK * 3` candidate fetch window.
 */
async function runHybridSearchInternal(
  env: HybridSearchEnv,
  db: WorkerD1Db,
  params: RunHybridSearchParams,
  opts: InternalOpts,
): Promise<HybridSearchResponse> {
  const topK = params.topK ?? 20;
  const requestedMode: HybridMode = params.mode ?? "hybrid";

  // Run the FTS path and shape it as a release-only response. Used both for
  // the explicit lexical mode and for every degraded fallback below.
  async function lexicalResponse(degradedReason?: string): Promise<HybridSearchResponse> {
    const ids = await ftsReleaseIds(db, params.query, topK * 3, {
      includeCoverage: params.includeCoverage,
      kind: params.kind,
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

  const embedder = await buildEmbedder(env, opts);
  const hasVectorize = !!env.RELEASES_INDEX && !!env.CHANGELOG_CHUNKS_INDEX && !!embedder;

  if (!hasVectorize) {
    return lexicalResponse(
      !embedder ? "embedding provider unavailable or misconfigured" : "vectorize bindings missing",
    );
  }

  // Build the vector-index list. Releases first so release kind wins
  // the RRF tiebreaker when the same id appears in multiple paths.
  // Coerce to the shared VectorizeIndex shape — hybridSearch only ever
  // calls `.query()` on these, so the write-side type mismatch is moot.
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

  // For "semantic" mode we still want a real ranked list but skip FTS.
  const ftsSearchFn =
    requestedMode === "semantic"
      ? async () => [] as { id: string }[]
      : async (q: string, limit: number) => {
          const ids = await ftsReleaseIds(db, q, limit, {
            includeCoverage: params.includeCoverage,
            kind: params.kind,
          });
          return ids.map((id) => ({ id }));
        };

  // Chunks skipped — they anchor to file slices, not dated entries. SQL
  // chunked at 90 ids/statement to stay under D1's 100-bind cap.
  const halfLifeDays = parseHalfLifeDays(env.SEARCH_RECENCY_HALFLIFE_DAYS);
  const halfLifeMs = halfLifeDays * 86_400_000;
  const boost30d = parseBoost(env.SEARCH_RECENCY_BOOST_30D, DEFAULT_BOOST_30D);
  // Clamp so an operator setting boost90d > boost30d can't invert the
  // taper (which would lift 60d-old content above 30d-old within the boost
  // layer). Silent — fires per request; logging would spam.
  const boost90d = Math.min(parseBoost(env.SEARCH_RECENCY_BOOST_90D, DEFAULT_BOOST_90D), boost30d);
  const now = Date.now();
  const scoreMultipliers = async (ids: string[]): Promise<Map<string, number>> => {
    const map = new Map<string, number>();
    const releaseIds = ids.filter((id) => getEntityType(id) === "release");
    if (releaseIds.length === 0) return map;
    const chunks = chunkArray(releaseIds, D1_IN_CHUNK);
    const results = await Promise.all(
      chunks.map((chunk) =>
        db.all<{ id: string; rankAt: string | null }>(sql`
          SELECT id, COALESCE(published_at, created_at) as rankAt
          FROM releases
          WHERE id IN (${sql.join(
            chunk.map((id) => sql`${id}`),
            sql`, `,
          )})
        `),
      ),
    );
    for (const row of results.flat()) {
      if (!row.rankAt) continue;
      const ageMs = now - new Date(row.rankAt).getTime();
      // Reject malformed dates (Invalid Date → NaN) and future timestamps.
      if (!Number.isFinite(ageMs) || ageMs <= 0) continue;
      const decay = Math.pow(0.5, ageMs / halfLifeMs);
      map.set(row.id, decay * recencyBoost(ageMs, boost30d, boost90d));
    }
    return map;
  };

  let fused: Awaited<ReturnType<typeof hybridSearch>>;
  try {
    fused = await hybridSearch({
      query: params.query,
      topK: topK * 3,
      ftsSearch: ftsSearchFn,
      vectorIndexes,
      embed: embedder,
      scoreMultipliers,
    });
  } catch (err) {
    logEvent("warn", {
      component: "search-hybrid",
      event: "vector-path-failed",
      err: err instanceof Error ? err : String(err),
    });
    return lexicalResponse(err instanceof Error ? err.message : String(err));
  }

  // Hydrate releases and chunks in parallel; reassemble in fused order below.
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

  // Re-merge in the original fused order.
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

/**
 * App Store platform + icon from a source's `metadata` JSON. Returns null for
 * non-`appstore` sources or unparseable metadata. Mirrors `appStoreSourceInfo`
 * in packages/adapters/src/appstore.ts and `getAppInfo` in web — duplicated
 * here to keep the search package's dep graph at `releases-core` only. #1206
 */
function appStoreInfoFromMetadata(
  type: string,
  metadataJson: string | null,
): { platform: "ios" | "macos"; iconUrl: string | null } | null {
  if (type !== "appstore") return null;
  let appStore: Record<string, unknown> | undefined;
  try {
    const block = (JSON.parse(metadataJson ?? "{}") as { appStore?: unknown } | null)?.appStore;
    if (block && typeof block === "object") appStore = block as Record<string, unknown>;
  } catch {
    appStore = undefined;
  }
  const platform = appStore?.platform === "macos" ? "macos" : "ios";
  const iconUrl = typeof appStore?.artworkUrl === "string" ? appStore.artworkUrl : null;
  return { platform, iconUrl };
}

/**
 * Video provider tag from a source's `metadata` JSON. Returns null for
 * non-`video` sources, unparseable metadata, or missing/invalid provider.
 * Mirrors `videoSourceInfo` in packages/adapters/src/source-meta.ts —
 * duplicated here to keep the search package's dep graph at `releases-core`
 * only (same reason `appStoreInfoFromMetadata` is self-contained).
 */
export function videoInfoFromMetadata(
  type: string,
  metadataJson: string | null,
): { provider: "youtube" | "vimeo" | "wistia" } | null {
  if (type !== "video") return null;
  try {
    const block = (JSON.parse(metadataJson ?? "{}") as { video?: { provider?: unknown } } | null)
      ?.video;
    const provider = block?.provider;
    if (provider === "youtube" || provider === "vimeo" || provider === "wistia") {
      return { provider };
    }
  } catch {
    // fall through
  }
  return null;
}

async function buildReleaseHits(
  db: WorkerD1Db,
  entries: Array<{ id: string; score: number }>,
  params: RunHybridSearchParams,
): Promise<HybridReleaseHit[]> {
  if (entries.length === 0) return [];
  const map = await hydrateReleases(
    db,
    entries.map((e) => e.id),
    { includeCoverage: params.includeCoverage, includeContent: params.includeContent },
  );
  const out: HybridReleaseHit[] = [];
  for (const entry of entries) {
    const row = map.get(entry.id);
    if (!row) continue;
    // Post-filter — see note on runHybridSearch.
    if (params.sourceId && row.sourceId !== params.sourceId) continue;
    if (params.orgSourceIds && !params.orgSourceIds.includes(row.sourceId)) continue;
    if (params.type && row.type !== params.type) continue;
    // COALESCE(source.kind, product.kind) must match the requested kind.
    if (params.kind && (row.sourceKind ?? row.productKind) !== params.kind) continue;
    // Time-window post-filter. ISO timestamps sort lexically, so string
    // comparison is correct; a NULL published_at fails both bounds and is
    // dropped — an undated release can't sit inside a window.
    if (params.since && (row.publishedAt === null || row.publishedAt < params.since)) continue;
    if (params.until && (row.publishedAt === null || row.publishedAt > params.until)) continue;
    // Drop empty / placeholder bodies so thin vectors (e.g. title+summary
    // "test") cannot surface via the semantic leg of hybrid RRF. Same
    // classifier as related rails — see content-quality.ts. Lexical-only
    // matches of pure junk are also filtered; callers that need every row
    // should hit entity/release detail routes, not search.
    if (
      isEmptyReleaseContent({
        title: row.title,
        summary: row.summary,
        contentChars:
          row.content != null && row.content !== ""
            ? row.content.length
            : (row.summary?.length ?? null),
      })
    ) {
      continue;
    }
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
        ...(row.content != null && row.content !== "" ? { content: row.content } : {}),
        media: row.media,
        source: {
          id: row.sourceId,
          slug: row.sourceSlug,
          name: row.sourceName,
          type: row.sourceType,
          appStore: appStoreInfoFromMetadata(row.sourceType, row.sourceMetadata),
          video: videoInfoFromMetadata(row.sourceType, row.sourceMetadata),
        },
        productSlug: row.productSlug,
        orgSlug: row.orgSlug,
        orgName: row.orgName,
        type: row.type,
        coverageCount: row.coverageCount,
      },
    });
  }
  return out;
}

// ── Collection semantic search ────────────────────────────────────────
//
// Collections share ENTITIES_INDEX with orgs/products/sources, distinguished
// by their `col_` ID prefix and the `type: "collection"` metadata tag. The
// helper runs a topical vector query, filters server-side to collection
// hits only, and hydrates them from D1 with member counts. Degrades the
// same way `runRegistrySearch` does — missing binding or embed error
// returns `degraded: true` with an empty hit list and the caller decides
// whether to fall back to lexical.

export interface CollectionSemanticHit {
  slug: string;
  name: string;
  description: string | null;
  memberCount: number;
  score: number;
}

/**
 * Relevance floor for semantic collection hits. The collections corpus is
 * tiny (~a dozen vectors), so a nearest-neighbor query always returns
 * *something* — without a floor, every query gets the same collections
 * reshuffled ("dark mode" → "Auth & Identity" at 0.42). Calibrated against
 * live scores (2026-06-11): genuine topical matches score 0.59–0.81, filler
 * tops out around 0.49. Applies to both /v1/search and the MCP search tool.
 */
export const COLLECTION_SEMANTIC_MIN_SCORE = 0.55;

/** Drop semantic collection matches below the relevance floor. */
export function filterCollectionMatches<T extends { score: number }>(matches: T[]): T[] {
  return matches.filter((m) => m.score >= COLLECTION_SEMANTIC_MIN_SCORE);
}

export interface CollectionSemanticResponse {
  degraded: boolean;
  degradedReason?: string;
  hits: CollectionSemanticHit[];
}

async function runCollectionsSemanticInternal(
  env: HybridSearchEnv,
  db: WorkerD1Db,
  params: { query: string; limit?: number },
  opts: InternalOpts,
): Promise<CollectionSemanticResponse> {
  const limit = params.limit ?? 20;

  const embedder = await buildEmbedder(env, opts);
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
    // Server-side filter on the kind discriminator — the vectorize index is
    // shared with orgs/products/sources, so we'd otherwise have to pull
    // (limit * N) candidates and toss the non-collection ones.
    const res = await env.ENTITIES_INDEX.query(vec, {
      topK: limit * 2,
      returnMetadata: "none",
      filter: { type: "collection" },
    });
    matches = filterCollectionMatches(res.matches.map((m) => ({ id: m.id, score: m.score })));
  } catch (err) {
    return {
      degraded: true,
      degradedReason: err instanceof Error ? err.message : String(err),
      hits: [],
    };
  }

  if (matches.length === 0) return { degraded: false, hits: [] };

  // Defense-in-depth: filter to `col_…` IDs in case the metadata filter
  // doesn't fire (older bindings, mis-tagged vectors). Cheap.
  const collectionIds = matches.map((m) => m.id).filter((id) => id.startsWith("col_"));
  if (collectionIds.length === 0) return { degraded: false, hits: [] };

  // Hydrate + compute memberCount in one query. Mirrors the
  // `searchCollectionsDirect` helper but bound by an `IN (…)` list rather
  // than a LIKE pattern. Chunked at D1_IN_CHUNK to stay under D1's 100-bind
  // cap.
  const memberCountSql = sql<number>`(
    SELECT COUNT(*)
    FROM ${collectionMembers} cm
    INNER JOIN ${organizationsPublic} op ON op.id = cm.org_id
    WHERE cm.collection_id = ${collections.id}
  )`;
  type CollectionHydrateRow = {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    memberCount: number;
  };
  const rowResults = await Promise.all(
    chunkArray(collectionIds, D1_IN_CHUNK).map((batch) =>
      db.all<CollectionHydrateRow>(sql`
        SELECT ${collections.id} as id,
               ${collections.slug} as slug,
               ${collections.name} as name,
               ${collections.description} as description,
               ${memberCountSql} as memberCount
        FROM ${collections}
        WHERE ${collections.id} IN (${sql.join(
          batch.map((id) => sql`${id}`),
          sql`, `,
        )})
      `),
    ),
  );
  const rows = rowResults.flat();

  const byId = new Map(rows.map((r) => [r.id, r]));
  const hits: CollectionSemanticHit[] = [];
  // Preserve Vectorize ranking order.
  for (const m of matches) {
    const row = byId.get(m.id);
    if (!row) continue;
    hits.push({
      slug: row.slug,
      name: row.name,
      description: row.description,
      memberCount: Number(row.memberCount),
      score: m.score,
    });
    if (hits.length >= limit) break;
  }
  return { degraded: false, hits };
}

// ── Entity (registry) semantic search ─────────────────────────────────

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

/**
 * Semantic search across the registry entity index (orgs, products,
 * sources). IDs in ENTITIES_INDEX are expected to be the entity's own
 * prefixed ID (`org_...`, `prod_...`, `src_...`) — hydration uses that
 * prefix to dispatch to the right table.
 */
async function runRegistrySearchInternal(
  env: HybridSearchEnv,
  db: WorkerD1Db,
  params: { query: string; kind?: EntityKind; limit?: number },
  opts: InternalOpts,
): Promise<RegistrySearchResponse> {
  const limit = params.limit ?? 20;

  const embedder = await buildEmbedder(env, opts);
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

  // Drizzle's `inArray(...)` expands to `IN (?, ?, ...)` — one bind per id —
  // so each bucket also needs chunking against D1's 100-bind cap. Buckets
  // are typically small but the bucket-skew worst case (all matches are one
  // kind) can push past 100 at high enough `limit`.
  async function fetchChunked<T>(
    should: boolean,
    ids: string[],
    query: (batch: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    if (!should) return [];
    const results = await Promise.all(chunkArray(ids, D1_IN_CHUNK).map(query));
    return results.flat();
  }

  const [orgRows, productRows, sourceRows] = await Promise.all([
    fetchChunked(shouldFetchOrgs, orgIds, (batch) =>
      db
        .select({
          id: organizationsActive.id,
          slug: organizationsActive.slug,
          name: organizationsActive.name,
          description: organizationsActive.description,
          category: organizationsActive.category,
        })
        .from(organizationsActive)
        .where(inArray(organizationsActive.id, batch)),
    ),
    fetchChunked(shouldFetchProducts, productIds, (batch) =>
      db
        .select({
          id: productsActive.id,
          slug: productsActive.slug,
          name: productsActive.name,
          description: productsActive.description,
          category: productsActive.category,
        })
        .from(productsActive)
        .where(inArray(productsActive.id, batch)),
    ),
    fetchChunked(shouldFetchSources, sourceIds, (batch) =>
      db
        .select({
          id: sourcesActive.id,
          slug: sourcesActive.slug,
          name: sourcesActive.name,
        })
        .from(sourcesActive)
        .where(inArray(sourcesActive.id, batch)),
    ),
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

  // Preserve Vectorize ranking by iterating `matches` in order.
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

// ── Worker-adapter factory ────────────────────────────────────────────
//
// Each worker calls this once with its local `buildEmbedConfig` and
// exports the returned bindings. Keeps `buildEmbedConfig` out of the
// per-call opts (it's a per-worker constant) and prevents the two
// adapter files from drifting as the public surface grows.

export interface WorkerSearch {
  runHybridSearch(
    env: HybridSearchEnv,
    db: WorkerD1Db,
    params: RunHybridSearchParams,
    opts?: HybridSearchOpts,
  ): Promise<HybridSearchResponse>;
  runCollectionsSemantic(
    env: HybridSearchEnv,
    db: WorkerD1Db,
    params: { query: string; limit?: number },
    opts?: HybridSearchOpts,
  ): Promise<CollectionSemanticResponse>;
  runRegistrySearch(
    env: HybridSearchEnv,
    db: WorkerD1Db,
    params: { query: string; kind?: EntityKind; limit?: number },
    opts?: HybridSearchOpts,
  ): Promise<RegistrySearchResponse>;
}

export function createWorkerSearch(buildEmbedConfig: BuildEmbedConfig): WorkerSearch {
  return {
    runHybridSearch: (env, db, params, opts = {}) =>
      runHybridSearchInternal(env, db, params, { ...opts, buildEmbedConfig }),
    runCollectionsSemantic: (env, db, params, opts = {}) =>
      runCollectionsSemanticInternal(env, db, params, { ...opts, buildEmbedConfig }),
    runRegistrySearch: (env, db, params, opts = {}) =>
      runRegistrySearchInternal(env, db, params, { ...opts, buildEmbedConfig }),
  };
}
