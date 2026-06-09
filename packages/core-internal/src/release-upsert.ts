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

/**
 * Clobbering variant of {@link RELEASE_URL_UPSERT} for a DELIBERATE content
 * enrichment pass (#1526). Same `(source_id, url)` key, but on collision it
 * OVERWRITES content/hash/size and media when the incoming row carries them —
 * instead of the fill-don't-clobber rule that only fills empty rows.
 *
 * This exists because the default rule (#958) cannot update a stub row that was
 * seeded with a one-line summary: once `releases.content` is non-empty, a richer
 * re-POST of the same URL is silently ignored. An operator running a real
 * second-pass enrichment (e.g. local-ingest: index summaries first, then full
 * detail-page bodies) needs the new content to win.
 *
 * Opt-in ONLY — reached via `mode: "upsert-content"` on `/releases/batch`, never
 * on the cron/MA re-fetch path, so a routine re-fetch that yields sparser content
 * can never clobber a good row. Content is taken only when non-empty (a blank
 * incoming body never wipes a stored one); media is taken only when non-empty
 * (`NULL`/`''`/`'[]'` never wipes stored media). A no-op row (blank content AND
 * blank media) is filtered by the WHERE so it doesn't churn the row.
 */
const MEDIA_HAS_CONTENT = sql`excluded.media IS NOT NULL AND excluded.media NOT IN ('', '[]')`;

export const RELEASE_CONTENT_UPSERT = {
  target: [releases.sourceId, releases.url],
  set: {
    content: sql`CASE WHEN excluded.content != '' THEN excluded.content ELSE releases.content END`,
    contentHash: sql`CASE WHEN excluded.content != '' THEN excluded.content_hash ELSE releases.content_hash END`,
    contentChars: sql`CASE WHEN excluded.content != '' THEN excluded.content_chars ELSE releases.content_chars END`,
    contentTokens: sql`CASE WHEN excluded.content != '' THEN excluded.content_tokens ELSE releases.content_tokens END`,
    media: sql`CASE WHEN ${MEDIA_HAS_CONTENT} THEN excluded.media ELSE releases.media END`,
  },
  where: sql`(excluded.content != '') OR (${MEDIA_HAS_CONTENT})`,
};
