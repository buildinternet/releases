/**
 * API-worker re-exports for the shared search-query log helpers in
 * `@releases/search/log-search`. The MCP worker re-exports the same module
 * from `workers/mcp/src/lib/log-search.ts`. Existing callers and tests
 * continue to import from this path.
 */
export {
  prepareSearchLogRow,
  logSearch,
  MAX_QUERY_LEN,
  type LogSearchInput,
  type SearchLogEnv as LogSearchEnv,
} from "@releases/search/log-search.js";
