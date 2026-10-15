/**
 * Releases whose source set `metadata.summarize = false` after a generation
 * job was already submitted. The collect query honors the opt-out; this
 * re-check is for the apply step hours later, and for any caller that loaded
 * rows before the flag flipped.
 *
 * Throws on a query error so a workflow step retries instead of writing
 * summaries for a source that opted out.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { releases, sources } from "@buildinternet/releases-core/schema";
import { chunkArray, IN_ARRAY_CHUNK_SIZE } from "@buildinternet/releases-core/d1-limits";
import type { D1Db } from "../../db.js";

export async function selectOptedOutReleaseIds(db: D1Db, ids: string[]): Promise<Set<string>> {
  const optedOut = new Set<string>();
  if (ids.length === 0) return optedOut;
  for (const chunk of chunkArray(ids, IN_ARRAY_CHUNK_SIZE)) {
    // oxlint-disable-next-line no-await-in-loop -- D1 chunked select (100 bind param limit)
    const rows = await db
      .select({ id: releases.id })
      .from(releases)
      .innerJoin(sources, eq(sources.id, releases.sourceId))
      .where(
        and(
          inArray(releases.id, [...chunk]),
          sql`json_extract(${sources.metadata}, '$.summarize') = 0`,
        ),
      );
    for (const row of rows) optedOut.add(row.id);
  }
  return optedOut;
}
