import { sql } from "drizzle-orm";
import { getDb } from "./connection.js";

export interface FtsResult {
  id: string;
  title: string;
  content: string;
  contentSummary: string | null;
  rank: number;
}

export function searchReleases(query: string, limit = 20): FtsResult[] {
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
