/**
 * Worker-local bindings for the shared hybrid-search helper in
 * `@releases/search/hybrid-search-worker`. `createWorkerSearch` baked
 * with the API worker's `buildEmbedConfig` keeps the call sites in
 * `workers/api/src/routes/search.ts` unchanged.
 *
 * The single source of truth for FTS, hydration, RRF wiring, and
 * degradation policy lives in the shared module. Runtime changes
 * belong upstream.
 */

import { createWorkerSearch } from "@releases/search/hybrid-search-worker.js";
import { buildEmbedConfig } from "@releases/search/embed-config.js";

export type {
  HybridSearchEnv,
  HybridSearchOpts,
  HybridMode,
  HybridReleaseHit,
  HybridChunkHit,
  HybridHit,
  HybridSearchResponse,
  RunHybridSearchParams,
  CollectionSemanticHit,
  CollectionSemanticResponse,
  EntityKind,
  RegistryHit,
  RegistrySearchResponse,
} from "@releases/search/hybrid-search-worker.js";

export const { runHybridSearch, runCollectionsSemantic, runRegistrySearch } =
  createWorkerSearch(buildEmbedConfig);
