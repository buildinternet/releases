import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * SQL mirror of `isPushFed()` (`@releases/adapters/source-meta`): the source is
 * fed by its publisher (`metadata.ingestMode = "push"`, #2374). Positive form,
 * for scans that target push-fed sources; see {@link locallyFetchedSql} for
 * the NULL-safe exclusion.
 */
export function pushFedSql(metadata: AnyColumn): SQL {
  return sql`json_extract(${metadata}, '$.ingestMode') = 'push'`;
}

/**
 * SQL guard for "this source is fetched locally": excludes sources driven from
 * outside our poll loop — Firecrawl monitoring (`metadata.firecrawl.enabled`)
 * and push-fed sources (`metadata.ingestMode = "push"`, #2374). Every
 * fetch-routing query (poll cron, OrgActor drain, unmanaged-actor sweep,
 * first-party staleness scan) uses this one predicate so a new externally
 * driven mode is added in one place. SQL mirror of `describeFetchPlan`'s
 * firecrawl/push precedence in `@releases/adapters/fetch-plan`.
 *
 * NULL-safe: `IS NOT` keeps rows where the key is absent (json_extract → NULL);
 * JSON `true` extracts as 1.
 */
export function locallyFetchedSql(metadata: AnyColumn): SQL {
  return sql`(json_extract(${metadata}, '$.firecrawl.enabled') IS NOT 1 AND json_extract(${metadata}, '$.ingestMode') IS NOT 'push')`;
}
