import { sql } from "drizzle-orm";
import type { AnyDb } from "../db.js";

export interface DatasetSourceRow {
  id: string;
  slug: string;
  name: string;
  metadata: string | null;
  orgSlug: string | null;
  orgName: string | null;
  isHidden: number;
  discovery: string;
  orgHidden: number | null;
  orgDeleted: string | null;
  orgDiscovery: string | null;
  orgTier: string | null;
  hasOverview: number;
  releaseCount: number;
}

export async function listDatasetSources(
  db: AnyDb,
  query: string,
  limit: number,
  offset: number,
): Promise<DatasetSourceRow[]> {
  // Bound the search before loading per-org eligibility; no unbounded in-memory list.
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  return db.all<DatasetSourceRow>(sql`
    SELECT s.id, s.slug, s.name, s.metadata, s.is_hidden AS isHidden, s.discovery,
      o.slug AS orgSlug, o.name AS orgName, o.is_hidden AS orgHidden,
      o.deleted_at AS orgDeleted, o.discovery AS orgDiscovery, o.tier AS orgTier,
      EXISTS(SELECT 1 FROM knowledge_pages kp WHERE kp.org_id = o.id AND kp.scope = 'org') AS hasOverview,
      (SELECT COUNT(*) FROM releases r JOIN sources rs ON rs.id = r.source_id WHERE rs.org_id = o.id) AS releaseCount
    FROM sources s LEFT JOIN organizations o ON o.id = s.org_id
    WHERE s.deleted_at IS NULL AND (${query} = '' OR s.name LIKE ${pattern} ESCAPE '\\'
      OR s.slug LIKE ${pattern} ESCAPE '\\' OR s.id LIKE ${pattern} ESCAPE '\\'
      OR o.slug LIKE ${pattern} ESCAPE '\\' OR o.name LIKE ${pattern} ESCAPE '\\')
    ORDER BY o.name, s.name, s.id LIMIT ${limit} OFFSET ${offset}
  `);
}
