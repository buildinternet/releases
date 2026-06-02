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
 *
 * Media is backfilled by the same fill-don't-clobber rule: write the incoming
 * media array only when it is non-empty AND the stored row has none (`NULL` or
 * `'[]'`); never overwrite media that's already populated, so R2-stamped media
 * and earlier good extractions survive a re-fetch. This lets a re-extraction
 * that now yields media (e.g. after the large-body guardrail stopped dropping
 * it) heal rows ingested while media came back empty — the only re-fetch path
 * that can, since `media-backfill.ts` only re-mirrors already-stored URLs.
 */
const MEDIA_NEEDS_BACKFILL = sql`excluded.media IS NOT NULL AND excluded.media NOT IN ('', '[]') AND (releases.media IS NULL OR releases.media IN ('', '[]'))`;

export const RELEASE_URL_UPSERT = {
  target: [releases.sourceId, releases.url],
  set: {
    content: sql`CASE WHEN excluded.content != '' AND releases.content = '' THEN excluded.content ELSE releases.content END`,
    contentHash: sql`CASE WHEN excluded.content != '' AND releases.content = '' THEN excluded.content_hash ELSE releases.content_hash END`,
    contentChars: sql`CASE WHEN excluded.content != '' AND releases.content = '' THEN excluded.content_chars ELSE releases.content_chars END`,
    contentTokens: sql`CASE WHEN excluded.content != '' AND releases.content = '' THEN excluded.content_tokens ELSE releases.content_tokens END`,
    media: sql`CASE WHEN ${MEDIA_NEEDS_BACKFILL} THEN excluded.media ELSE releases.media END`,
  },
  where: sql`(excluded.content != '' AND releases.content = '') OR (${MEDIA_NEEDS_BACKFILL})`,
};
