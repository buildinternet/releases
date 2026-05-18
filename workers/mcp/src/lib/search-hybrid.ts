/**
 * Worker-local bindings for the shared hybrid-search helper in
 * `@releases/search/hybrid-search-worker`. `createWorkerSearch` baked
 * with the MCP worker's `buildEmbedConfig` keeps the call sites in
 * `workers/mcp/src/tools.ts` unchanged.
 *
 * The shared module statically imports `embedBatch` from
 * `@releases/search/embeddings.js`, which reads `process.env` at module
 * scope. The MCP tsconfig shims `process` via `src/stubs/process.d.ts`
 * so type-check passes; at runtime the Workers runtime exposes
 * `process.env = {}` and the embeddings module never reaches for real
 * values because we pass an explicit `EmbeddingConfig` override.
 */

import { createWorkerSearch } from "@releases/search/hybrid-search-worker.js";
import { buildEmbedConfig } from "./embed-config.js";

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
