/**
 * Worker-local bindings for the shared hybrid-search helper in
 * `@releases/search/hybrid-search-worker`. `createWorkerSearch` baked with
 * the shared `buildEmbedConfig` keeps the call sites in
 * `workers/mcp/src/tools.ts` unchanged.
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
