/**
 * Hybrid search orchestration: runs FTS5 and one-or-more Cloudflare Vectorize
 * indexes in parallel and merges results with Reciprocal Rank Fusion (RRF).
 *
 * Pure RRF lives in `reciprocalRankFusion`. The orchestrator is the only
 * impure function here — it accepts an `embed` callback and an `ftsSearch`
 * callback so the same module can be used from a Worker (Vectorize binding)
 * and from the local CLI in remote mode (HTTP-shaped wrapper).
 *
 * Runtime-agnostic: we deliberately avoid importing
 * `@cloudflare/workers-types` so this file can be loaded in Node/Bun/CLI.
 */

/**
 * Scalar metadata values accepted by Cloudflare Vectorize (v1, April 2026).
 * This mirrors the `VectorizeVectorMetadata` type from `@cloudflare/workers-types`,
 * but is re-declared here so this file stays runtime-agnostic (the CLI compiles
 * without workers-types in its lib set).
 */
export type VectorMetadataValue = string | number | boolean | string[];

/** Minimal shape of a Cloudflare Vectorize index binding (v1, April 2026). */
export interface VectorizeIndex {
  query(
    vector: number[],
    options?: {
      topK?: number;
      returnValues?: boolean;
      returnMetadata?: boolean | "none" | "indexed" | "all";
      filter?: Record<string, unknown>;
    },
  ): Promise<{
    matches: Array<{ id: string; score: number; metadata?: Record<string, VectorMetadataValue> }>;
  }>;
  upsert(
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: Record<string, VectorMetadataValue>;
    }>,
  ): Promise<{ mutationId: string }>;
  deleteByIds(ids: string[]): Promise<{ mutationId: string }>;
}

export interface RankedEntry<T> {
  id: string;
  item: T;
}

export interface RrfResult<T> {
  id: string;
  item: T;
  score: number;
  appearances: number;
}

export interface RrfOptions {
  /** RRF constant. Defaults to 60 — the standard value from Cormack et al. */
  k?: number;
}

/**
 * Pure Reciprocal Rank Fusion.
 *
 * Contribution per appearance: `1 / (k + rank)` where `rank` is 1-indexed
 * (so the top of every list contributes `1 / (k + 1)`). When the same id
 * appears in multiple lists, contributions are summed.
 *
 * Tie-break for `item` payload when an id appears in more than one list:
 * the **first item seen** (by list iteration order) is kept. Lists are
 * processed in the order supplied, so callers can put the more-trustworthy
 * source first if `item` content matters. The accumulated `score` is the
 * authoritative ranking signal regardless.
 */
export function reciprocalRankFusion<T>(
  rankedLists: Array<Array<RankedEntry<T>>>,
  options: RrfOptions = {},
): Array<RrfResult<T>> {
  const k = options.k ?? 60;
  const acc = new Map<string, RrfResult<T>>();

  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry) continue;
      const rank = i + 1; // 1-indexed
      const contribution = 1 / (k + rank);
      const existing = acc.get(entry.id);
      if (existing) {
        existing.score += contribution;
        existing.appearances += 1;
      } else {
        acc.set(entry.id, {
          id: entry.id,
          item: entry.item,
          score: contribution,
          appearances: 1,
        });
      }
    }
  }

  return Array.from(acc.values()).toSorted((a, b) => b.score - a.score);
}

export interface HybridFtsHit {
  id: string;
  score?: number;
}

export interface HybridVectorIndex {
  /** Display name, e.g. "releases-v1". Used as the `source` tag on results. */
  name: string;
  /** Authoritative kind for hits coming out of this index. */
  kind: string;
  index: VectorizeIndex;
}

export interface HybridSearchParams {
  query: string;
  topK?: number;
  ftsSearch: (query: string, limit: number) => Promise<HybridFtsHit[]>;
  vectorIndexes: HybridVectorIndex[];
  embed: (text: string) => Promise<number[]>;
  filter?: Record<string, unknown>;
  /**
   * Optional post-fusion score multipliers — applied after RRF, then the
   * result is re-sorted by score DESC. Use for continuous boosts that
   * don't fit RRF's rank shape (time-decay, popularity, quality). Missing
   * ids default to 1.0 (pass-through). Throws are swallowed and the base
   * fusion order stands.
   */
  scoreMultipliers?: (ids: string[]) => Promise<Map<string, number>>;
}

export interface HybridSearchResult {
  id: string;
  score: number;
  kind: string;
  source: string;
  appearances: number;
}

interface InternalHit {
  source: string;
  kind: string;
  /**
   * `true` when this hit came from a vector index (authoritative kind).
   * Used to decide kind precedence during RRF merge.
   */
  fromVector: boolean;
}

/**
 * Hybrid search orchestrator.
 *
 * Runs the FTS query and every vector-index query in parallel, tags each
 * hit with its source name (`"fts"` or the vector index `name`), then
 * merges the ranked lists with RRF.
 *
 * **Kind precedence**: when the same id appears in both FTS and at least
 * one vector index, the vector kind wins. FTS only ever returns release
 * IDs, so its `kind` is the generic `"release"` fallback and would be
 * misleading for, e.g., a `changelog_chunk` hit that happens to share an
 * id namespace with a release. Among multiple vector indexes, the
 * **first** vector index that produced a hit (by `vectorIndexes` order)
 * wins — callers should order indexes by descending precedence.
 *
 * **Empty-query short-circuit**: if `query` is empty (or whitespace-only),
 * `embed` is not called and only the FTS path runs. This avoids billing
 * an embedding API call for a query that can't produce a meaningful
 * vector anyway.
 */
export async function hybridSearch(params: HybridSearchParams): Promise<HybridSearchResult[]> {
  const topK = params.topK ?? 20;
  const trimmed = params.query.trim();
  const skipVector = trimmed.length === 0;

  const ftsPromise: Promise<HybridFtsHit[]> = params.ftsSearch(params.query, topK).catch(() => []);

  const vectorPromises: Array<Promise<{ name: string; kind: string; matches: HybridFtsHit[] }>> =
    skipVector
      ? []
      : params.vectorIndexes.map(async (vi) => {
          try {
            const vector = await params.embed(params.query);
            const result = await vi.index.query(vector, {
              topK,
              returnMetadata: "none",
              filter: params.filter,
            });
            return {
              name: vi.name,
              kind: vi.kind,
              matches: result.matches.map((m) => ({ id: m.id, score: m.score })),
            };
          } catch {
            return { name: vi.name, kind: vi.kind, matches: [] };
          }
        });

  const [ftsHits, ...vectorResults] = await Promise.all([ftsPromise, ...vectorPromises]);

  // Build ranked lists for RRF, each entry tagged with provenance.
  const lists: Array<Array<RankedEntry<InternalHit>>> = [];

  // Vector lists go first so vector kind wins the "first item seen" tiebreaker.
  for (const vr of vectorResults) {
    lists.push(
      vr.matches.map((m) => ({
        id: m.id,
        item: { source: vr.name, kind: vr.kind, fromVector: true },
      })),
    );
  }

  lists.push(
    ftsHits.map((h) => ({
      id: h.id,
      item: { source: "fts", kind: "release", fromVector: false },
    })),
  );

  const fused = reciprocalRankFusion(lists);

  if (params.scoreMultipliers && fused.length > 0) {
    try {
      const multipliers = await params.scoreMultipliers(fused.map((e) => e.id));
      for (const entry of fused) entry.score *= multipliers.get(entry.id) ?? 1;
      fused.sort((a, b) => b.score - a.score);
    } catch {
      // Opportunistic — base fusion stands if the multiplier lookup fails.
    }
  }

  return fused.slice(0, topK).map((entry) => ({
    id: entry.id,
    score: entry.score,
    kind: entry.item.kind,
    source: entry.item.source,
    appearances: entry.appearances,
  }));
}
