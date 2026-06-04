/**
 * Worker side of scrape title-dedup (#1410): load the set of normalized title
 * keys already stored for a source, so an insert path can drop incoming scrape
 * releases that duplicate an existing entry under a different anchor URL. The pure
 * key + filter live in `@buildinternet/releases-core/title-dedup`.
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { releases } from "@buildinternet/releases-core/schema";
import { normalizeTitleKey } from "@buildinternet/releases-core/title-dedup";

// Loose drizzle handle (matches the worker-helper convention in media-ingest.ts)
// so both the schema-typed createDb result and poll-fetch's drizzle handle pass.
type Db = ReturnType<typeof drizzle>;

/**
 * Existing release identity for a source: the set of normalized title keys and the
 * set of stored URLs. The dedup filter needs both — title to match cross-anchor
 * dups, urls to leave same-row re-fetches to the UNIQUE(source_id,url) path.
 */
export async function selectExistingReleaseKeys(
  db: Db,
  sourceId: string,
): Promise<{ titleKeys: Set<string>; urls: Set<string> }> {
  const rows = await db
    .select({ title: releases.title, url: releases.url })
    .from(releases)
    .where(eq(releases.sourceId, sourceId));
  const titleKeys = new Set<string>();
  const urls = new Set<string>();
  for (const r of rows) {
    if (typeof r.title === "string") {
      const key = normalizeTitleKey(r.title);
      if (key) titleKeys.add(key);
    }
    if (typeof r.url === "string" && r.url) urls.add(r.url);
  }
  return { titleKeys, urls };
}
