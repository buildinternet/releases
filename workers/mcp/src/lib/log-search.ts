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
import { logger } from "@buildinternet/releases-lib/logger";

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
  /**
   * UA-derived bucket for the MCP transport — Anthropic-* / claude-* land in
   * `mcp-claude`. When omitted, `prepareMcpSearchLogRow` falls back to
   * `deriveMcpClientKind(userAgent)`; if that also returns null the row is
   * written without `clientKind` and the column's schema default fills in.
   */
  clientKind?: string | null;
  userAgent?: string | null;
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

/**
 * UA-derived MCP client kind. Most managed-agent traffic carries an
 * `Anthropic-...` UA and Claude Desktop sends `claude-...`; anything else
 * (custom MCP clients, curl, raw fetch) is unknown and returns `null`, which
 * lets the column fall back to its schema default rather than mis-labelling
 * unknown traffic.
 */
export function deriveMcpClientKind(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  if (ua.startsWith("claude-") || ua.startsWith("anthropic-") || ua.includes("anthropic"))
    return "mcp-claude";
  return null;
}

export function prepareMcpSearchLogRow(input: McpLogSearchInput): NewSearchQuery | null {
  const query = input.query.trim().slice(0, MAX_QUERY_LEN);
  if (!query) return null;

  const mode =
    input.mode && (SEARCH_MODES as readonly string[]).includes(input.mode) ? input.mode : null;
  // Default `types` to the command name so admin queries can filter by tool.
  const typesArr = input.types && input.types.length > 0 ? input.types : [input.command];

  const clientKind =
    trimOrNull(input.clientKind, 64) ?? deriveMcpClientKind(input.userAgent ?? null);

  return {
    timestamp: input.timestamp ?? Date.now(),
    surface: "mcp",
    // Only forward when we identified the client; otherwise let the column
    // fall back to its schema default — the status UI hides the pill for
    // default values so "no signal" reads as absence, not a labelled bucket.
    ...(clientKind ? { clientKind } : {}),
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
    userAgent: trimOrNull(input.userAgent, 256),
    // MCP transport doesn't carry a Releases API key today; logging NULL
    // (rather than `false`) keeps the option open if/when Bearer auth lands
    // on /mcp without a back-fill rewrite.
    authed: null,
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
    // Never break a tool response on a logging failure.
    logger.error("[search-log] insert failed", { err });
  }
}
