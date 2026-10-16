import { sql, type SQL } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";

/** Background writers replace fetch metadata from an earlier snapshot. Dataset
 * settings belong to operators: retain the live key, including a concurrent
 * reset/removal, in the same UPDATE instead of replaying that stale snapshot. */
export function preserveLiveSourceDataset(replacement: string): SQL {
  return sql`CASE WHEN json_valid(${sources.metadata}) THEN CASE WHEN json_type(${sources.metadata}, '$.dataset') IS NOT NULL THEN json_set(${replacement}, '$.dataset', json_extract(${sources.metadata}, '$.dataset')) ELSE json_remove(${replacement}, '$.dataset') END ELSE json_remove(${replacement}, '$.dataset') END`;
}
