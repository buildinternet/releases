/**
 * Fire-and-forget search-query log for the MCP worker. Mirrors the helper in
 * `workers/api/src/lib/log-search.ts` so the MCP worker doesn't reach into
 * the API worker's source tree. Both paths write the same `search_queries`
 * table on the shared D1.
 */
import {
  searchQueries,
  SEARCH_MODES,
  type NewSearchQuery,
  type SearchMode,
} from "@buildinternet/releases-core/schema";
import { drizzle } from "drizzle-orm/d1";

export const MAX_QUERY_LEN = 200;
const MAX_STR = 200;

export type McpSearchCommand = "search" | "search_releases" | "search_registry";

export interface McpLogSearchInput {
  command: McpSearchCommand;
  query: string;
  mode?: SearchMode | null;
  types?: readonly string[] | null;
  organization?: string | null;
  entity?: string | null;
  orgHits?: number | null;
  catalogHits?: number | null;
  releaseHits?: number | null;
  chunkHits?: number | null;
  degraded?: boolean | null;
  durationMs?: number | null;
  sessionId?: string | null;
  timestamp?: number;
}

export interface McpLogSearchEnv {
  DB: D1Database;
  SEARCH_QUERY_LOG_DISABLED?: string;
}

// Same shape as `sanitizeString` in `workers/api/src/lib/sanitize.ts` —
// duplicated because workers can't share source. If the MCP worker ever
// pulls in a shared private package, fold both into one.
function trimOrNull(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, max);
  return t.length > 0 ? t : null;
}

export function prepareMcpSearchLogRow(input: McpLogSearchInput): NewSearchQuery | null {
  const query = input.query.trim().slice(0, MAX_QUERY_LEN);
  if (!query) return null;

  const mode =
    input.mode && (SEARCH_MODES as readonly string[]).includes(input.mode) ? input.mode : null;
  // Default `types` to the command name so admin queries can filter by tool.
  const typesArr = input.types && input.types.length > 0 ? input.types : [input.command];

  return {
    timestamp: input.timestamp ?? Date.now(),
    surface: "mcp",
    clientKind: "external",
    query,
    mode,
    types: JSON.stringify(typesArr),
    organization: trimOrNull(input.organization, MAX_STR),
    entity: trimOrNull(input.entity, MAX_STR),
    orgHits: input.orgHits ?? null,
    catalogHits: input.catalogHits ?? null,
    releaseHits: input.releaseHits ?? null,
    chunkHits: input.chunkHits ?? null,
    degraded: input.degraded ?? null,
    durationMs: input.durationMs ?? null,
    anonId: null,
    sessionId: trimOrNull(input.sessionId, 64),
    userAgent: null,
  };
}

export async function logMcpSearch(env: McpLogSearchEnv, input: McpLogSearchInput): Promise<void> {
  if (env.SEARCH_QUERY_LOG_DISABLED === "true") return;
  const row = prepareMcpSearchLogRow(input);
  if (!row) return;
  try {
    const db = drizzle(env.DB);
    await db.insert(searchQueries).values(row);
  } catch (err) {
    // Never break a tool response on a logging failure, but surface to
    // tail logs so a future schema drift doesn't silently drop every row.
    console.error("[search-log] insert failed", err);
  }
}
