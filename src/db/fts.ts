import { sql } from "drizzle-orm";
import { getDb } from "./connection.js";
import { isRemoteMode } from "../lib/mode.js";
import * as apiClient from "../api/client.js";

export interface FtsResult {
  id: string;
  title: string;
  content: string;
  contentSummary: string | null;
  rank: number;
}

export function searchReleases(query: string, limit = 20): FtsResult[] {
  if (isRemoteMode()) {
    throw new Error("searchReleases() is not available in remote mode — use searchReleasesRemote() from queries.ts instead");
  }
  const db = getDb();
  const results = db.all<FtsResult>(sql`
    SELECT
      r.id,
      r.title,
      r.content,
      r.content_summary as contentSummary,
      rank
    FROM releases_fts
    JOIN releases r ON r.rowid = releases_fts.rowid
    WHERE releases_fts MATCH ${query}
    ORDER BY rank
    LIMIT ${limit}
  `);
  return results;
}

export interface SearchApiResult {
  sourceSlug: string;
  sourceName: string;
  orgSlug: string | null;
  version: string | null;
  title: string;
  summary: string;
  publishedAt: string | null;
}

export async function searchReleasesForApi(query: string, limit: number, offset: number): Promise<SearchApiResult[]> {
  if (isRemoteMode()) return apiClient.searchReleasesForApi(query, limit, offset) as Promise<SearchApiResult[]>;
  const db = getDb();
  return db.all<SearchApiResult>(sql`
    SELECT
      s.slug as sourceSlug,
      s.name as sourceName,
      o.slug as orgSlug,
      r.version,
      r.title,
      COALESCE(r.content_summary, SUBSTR(r.content, 1, 150)) as summary,
      r.published_at as publishedAt
    FROM releases_fts
    JOIN releases r ON r.rowid = releases_fts.rowid
    JOIN sources s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    WHERE releases_fts MATCH ${query}
    ORDER BY rank
    LIMIT ${limit}
    OFFSET ${offset}
  `);
}
