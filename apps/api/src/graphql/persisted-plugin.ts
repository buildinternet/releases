/**
 * The persisted-operations Yoga plugin, split out of `persisted.ts` so the
 * cache helpers there (imported by `lib/latest-cache.ts` on every isolate)
 * don't pull `@graphql-yoga/plugin-persisted-operations` — and graphql-yoga
 * with it — into worker startup. Only the lazily loaded Yoga server imports it.
 */
import {
  defaultExtractPersistedOperationId,
  usePersistedOperations,
  type ExtractPersistedOperationId,
} from "@graphql-yoga/plugin-persisted-operations";
import { getPersistedOperation, isAdminRequest } from "./persisted.js";

/**
 * Yoga plugin enforcing persisted operations. Non-admin callers must send a
 * known hash; admin callers (sentinel header set) may send arbitrary
 * documents (GraphiQL playground, ad-hoc debugging).
 */
export function persistedOperationsPlugin() {
  // Custom extractor: skip lookup for admin requests sending raw documents,
  // so they pass through untouched. The plugin's own logic handles the
  // hash-bearing case for everyone else.
  const extract: ExtractPersistedOperationId = (params, request, context) => {
    if (isAdminRequest(request) && typeof params.query === "string") return null;
    return defaultExtractPersistedOperationId(params, request, context);
  };
  return usePersistedOperations({
    extractPersistedOperationId: extract,
    allowArbitraryOperations: (request) => isAdminRequest(request),
    getPersistedOperation: (hash) => getPersistedOperation(hash),
  });
}
