import { sql } from "drizzle-orm";
import { releases, type NewRelease } from "@buildinternet/releases-core/schema";

export type ReleaseUpsertRow = NewRelease;

/**
 * Shared conflict resolution for upserting release rows. Keyed on
 * (source_id, url). On collision, backfill content + contentHash when the
 * incoming row has non-empty content and the existing row is empty — lets a
 * re-fetch fill in sparse stub rows without overwriting rows that already
 * have content. `content_chars` / `content_tokens` are backfilled on the same
 * condition so the size cache tracks the body. #958.
 */
export const RELEASE_URL_UPSERT = {
  target: [releases.sourceId, releases.url],
  set: {
    content: sql`CASE WHEN excluded.content != '' AND releases.content = '' THEN excluded.content ELSE releases.content END`,
    contentHash: sql`CASE WHEN excluded.content != '' AND releases.content = '' THEN excluded.content_hash ELSE releases.content_hash END`,
    contentChars: sql`CASE WHEN excluded.content != '' AND releases.content = '' THEN excluded.content_chars ELSE releases.content_chars END`,
    contentTokens: sql`CASE WHEN excluded.content != '' AND releases.content = '' THEN excluded.content_tokens ELSE releases.content_tokens END`,
  },
  where: sql`excluded.content != '' AND releases.content = ''`,
};
