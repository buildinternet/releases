/**
 * Fire-and-forget search-query log. Shared by the api and mcp workers — both
 * write the same `search_queries` table on the shared D1. The per-worker
 * input adapters (`prepareSearchLogRow` for api, `prepareMcpSearchLogRow` for
 * mcp) differ only in their input shape; the row-shaping + insert path is
 * identical and lives here.
 *
 * Call sites should wrap `logSearch` / `logMcpSearch` in `waitUntil` so the
 * response never waits on the insert and never fails because of it.
 */

import { type AnyD1Database, drizzle } from "drizzle-orm/d1";

import {
  searchQueries,
  SEARCH_SURFACES,
  SEARCH_MODES,
  type NewSearchQuery,
  type SearchSurface,
  type SearchMode,
} from "@buildinternet/releases-core/schema";
import { dbErrorLogFields } from "@releases/lib/db-errors";
import { logEvent } from "@releases/lib/log-event";
import type { FlagshipBinding } from "@releases/lib/flags";

export const MAX_QUERY_LEN = 200;
const MAX_STR = 200;
const MAX_UA = 256;

export interface SearchLogEnv {
  // Typed via drizzle so this module compiles under a tsconfig that doesn't
  // pull in `@cloudflare/workers-types`. Workers bind a real `D1Database`.
  DB: AnyD1Database;
  /**
   * When "true", `logSearch` / `logMcpSearch` short-circuit without writing.
   * Useful for staging or for backing the kill switch off without
   * redeploying. Default (unset) leaves logging enabled.
   */
  SEARCH_QUERY_LOG_DISABLED?: string;
  /** Flagship binding forwarded by the worker; resolves the kill switch live. */
  FLAGS?: FlagshipBinding;
}

/** Trim, slice to `max`, and treat the empty string as null. */
function trimOrNull(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, max);
  return t.length > 0 ? t : null;
}

/** Drop modes that aren't in the SEARCH_MODES enum rather than persisting them. */
function pickMode(mode: SearchMode | null | undefined): SearchMode | null {
  return mode && (SEARCH_MODES as readonly string[]).includes(mode) ? mode : null;
}

// ---------------------------------------------------------------------------
// API worker variant
// ---------------------------------------------------------------------------

export interface LogSearchInput {
  surface: SearchSurface;
  query: string;
  clientKind?: string | null;
  mode?: SearchMode | null;
  types?: readonly string[] | null;
  organization?: string | null;
  entity?: string | null;
  orgHits?: number | null;
  catalogHits?: number | null;
  releaseHits?: number | null;
  chunkHits?: number | null;
  collectionHits?: number | null;
  degraded?: boolean | null;
  durationMs?: number | null;
  anonId?: string | null;
  sessionId?: string | null;
  userAgent?: string | null;
  authed?: boolean | null;
  timestamp?: number;
}

/**
 * Pure validation + normalization of a log row from an API-worker caller.
 * Exposed so tests can verify sanitization without spinning up D1. Returns
 * `null` when the row should be dropped entirely (empty query, unknown
 * surface).
 */
export function prepareSearchLogRow(input: LogSearchInput): NewSearchQuery | null {
  if (!(SEARCH_SURFACES as readonly string[]).includes(input.surface)) return null;

  const query = input.query.trim().slice(0, MAX_QUERY_LEN);
  if (!query) return null;

  // Only forward clientKind when the caller actually identified the client.
  // Omitting lets the column fall back to its schema default ("external"),
  // which the status UI treats as "no signal" and hides from the pill row.
  const clientKind = trimOrNull(input.clientKind, 64);

  return {
    timestamp: input.timestamp ?? Date.now(),
    surface: input.surface,
    ...(clientKind ? { clientKind } : {}),
    query,
    mode: pickMode(input.mode),
    types:
      Array.isArray(input.types) && input.types.length > 0 ? JSON.stringify(input.types) : null,
    organization: trimOrNull(input.organization, MAX_STR),
    entity: trimOrNull(input.entity, MAX_STR),
    orgHits: input.orgHits ?? null,
    catalogHits: input.catalogHits ?? null,
    releaseHits: input.releaseHits ?? null,
    chunkHits: input.chunkHits ?? null,
    collectionHits: input.collectionHits ?? null,
    degraded: input.degraded ?? null,
    durationMs: input.durationMs ?? null,
    anonId: trimOrNull(input.anonId, 64),
    sessionId: trimOrNull(input.sessionId, 64),
    userAgent: trimOrNull(input.userAgent, MAX_UA),
    authed: input.authed ?? null,
  };
}

export async function logSearch(env: SearchLogEnv, input: LogSearchInput): Promise<void> {
  if (env.SEARCH_QUERY_LOG_DISABLED === "true") return;
  const row = prepareSearchLogRow(input);
  if (!row) return;
  await writeRow(env, row);
}

// ---------------------------------------------------------------------------
// MCP worker variant
// ---------------------------------------------------------------------------

export type McpSearchCommand = "search";

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
  collectionHits?: number | null;
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
    mode: pickMode(input.mode),
    types: JSON.stringify(typesArr),
    organization: trimOrNull(input.organization, MAX_STR),
    entity: trimOrNull(input.entity, MAX_STR),
    orgHits: input.orgHits ?? null,
    catalogHits: input.catalogHits ?? null,
    releaseHits: input.releaseHits ?? null,
    chunkHits: input.chunkHits ?? null,
    collectionHits: input.collectionHits ?? null,
    degraded: input.degraded ?? null,
    durationMs: input.durationMs ?? null,
    anonId: null,
    sessionId: trimOrNull(input.sessionId, 64),
    userAgent: trimOrNull(input.userAgent, MAX_UA),
    // MCP transport doesn't carry a Releases API key today; logging NULL
    // (rather than `false`) keeps the option open if/when Bearer auth lands
    // on /mcp without a back-fill rewrite.
    authed: null,
  };
}

export async function logMcpSearch(env: SearchLogEnv, input: McpLogSearchInput): Promise<void> {
  if (env.SEARCH_QUERY_LOG_DISABLED === "true") return;
  const row = prepareMcpSearchLogRow(input);
  if (!row) return;
  await writeRow(env, row);
}

// ---------------------------------------------------------------------------
// Shared insert path
// ---------------------------------------------------------------------------

async function writeRow(env: SearchLogEnv, row: NewSearchQuery): Promise<void> {
  try {
    const db = drizzle(env.DB);
    await db.insert(searchQueries).values(row);
  } catch (err) {
    // Never break a search response on a logging failure.
    logEvent("error", {
      component: "search-log",
      event: "insert-failed",
      err,
      ...dbErrorLogFields(err),
    });
  }
}
