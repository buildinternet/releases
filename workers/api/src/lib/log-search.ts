import {
  searchQueries,
  SEARCH_SURFACES,
  SEARCH_MODES,
  type NewSearchQuery,
  type SearchSurface,
  type SearchMode,
} from "@buildinternet/releases-core/schema";
import { drizzle } from "drizzle-orm/d1";
import { sanitizeString } from "./sanitize.js";
import { logEvent } from "@releases/lib/log-event";
import { dbErrorLogFields } from "@releases/lib/db-errors";

export const MAX_QUERY_LEN = 200;
const MAX_STR = 200;
const MAX_UA = 256;

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

export interface LogSearchEnv {
  DB: D1Database;
  /**
   * When "true", `logSearch` short-circuits without writing. Useful for
   * staging or for backing the kill switch off without redeploying. Default
   * (unset) leaves logging enabled.
   */
  SEARCH_QUERY_LOG_DISABLED?: string;
}

/**
 * Pure validation + normalization of a log row. Exposed so tests can verify
 * sanitization without spinning up D1. Returns `null` when the row should be
 * dropped entirely (empty query, unknown surface).
 */
export function prepareSearchLogRow(input: LogSearchInput): NewSearchQuery | null {
  if (!(SEARCH_SURFACES as readonly string[]).includes(input.surface)) return null;

  const query = input.query.trim().slice(0, MAX_QUERY_LEN);
  if (!query) return null;

  const mode =
    input.mode && (SEARCH_MODES as readonly string[]).includes(input.mode) ? input.mode : null;
  const types =
    Array.isArray(input.types) && input.types.length > 0 ? JSON.stringify(input.types) : null;

  // Only forward clientKind when the caller actually identified the client.
  // Omitting lets the column fall back to its schema default ("external"),
  // which the status UI treats as "no signal" and hides from the pill row.
  const clientKind = sanitizeString(input.clientKind, 64);

  return {
    timestamp: input.timestamp ?? Date.now(),
    surface: input.surface,
    ...(clientKind ? { clientKind } : {}),
    query,
    mode,
    types,
    organization: sanitizeString(input.organization, MAX_STR),
    entity: sanitizeString(input.entity, MAX_STR),
    orgHits: input.orgHits ?? null,
    catalogHits: input.catalogHits ?? null,
    releaseHits: input.releaseHits ?? null,
    chunkHits: input.chunkHits ?? null,
    collectionHits: input.collectionHits ?? null,
    degraded: input.degraded ?? null,
    durationMs: input.durationMs ?? null,
    anonId: sanitizeString(input.anonId, 64),
    sessionId: sanitizeString(input.sessionId, 64),
    userAgent: sanitizeString(input.userAgent, MAX_UA),
    authed: input.authed ?? null,
  };
}

/**
 * Fire-and-forget search-query log. Wrap with `waitUntil` at the call site so
 * the response never waits on the insert and never fails because of it.
 */
export async function logSearch(env: LogSearchEnv, input: LogSearchInput): Promise<void> {
  if (env.SEARCH_QUERY_LOG_DISABLED === "true") return;
  const row = prepareSearchLogRow(input);
  if (!row) return;
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
