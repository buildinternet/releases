/**
 * MCP-worker re-exports for the shared search-query log helpers in
 * `@releases/search/log-search`. The API worker re-exports the same module
 * from `workers/api/src/lib/log-search.ts`. Existing callers and tests
 * continue to import from this path.
 */
export {
  prepareMcpSearchLogRow,
  logMcpSearch,
  deriveMcpClientKind,
  MAX_QUERY_LEN,
  type McpLogSearchInput,
  type McpSearchCommand,
  type SearchLogEnv as McpLogSearchEnv,
} from "@releases/search/log-search.js";
