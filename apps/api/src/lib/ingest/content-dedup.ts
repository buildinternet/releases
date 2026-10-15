/**
 * Worker side of content-identity dedup. The pure normalize/match lives in
 * `@buildinternet/releases-core/content-dedup`; this module hashes with the
 * worker's sha256 and loads the same-day rows a source already has.
 */
import { and, eq, gte, lt, or, type SQL } from "drizzle-orm";
import { releases } from "@buildinternet/releases-core/schema";
import {
  MIN_NORMALIZED_BODY_CHARS,
  dedupeByContentIdentity,
  normalizeReleaseBody,
  publishedDay,
  type ContentIdentity,
} from "@buildinternet/releases-core/content-dedup";
import { sha256Hex } from "@releases/core-internal/hash";
import type { AnyDb } from "../../db.js";
import { assertBindBudget, chunkForBindBudget, maxChunkLength } from "../d1-limits.js";

export function releaseBodyHash(content: string, title?: string | null): string | null {
  const normalized = normalizeReleaseBody(content, title);
  if (normalized.length < MIN_NORMALIZED_BODY_CHARS) return null;
  return sha256Hex(normalized);
}

type DedupItem = ContentIdentity & { content?: string | null };

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** `published_at >= ? AND published_at < ?` — two binds per calendar day. */
const CONTENT_IDENTITY_DAY_BINDS = 2;
/** The `source_id = ?` predicate beside the day ranges. */
const CONTENT_IDENTITY_FIXED_BINDS = 1;

/**
 * Days per content-identity SELECT. One source id plus two binds per day, so
 * 49 days is 99 parameters — the last size that fits D1's cap of 100.
 */
export const CONTENT_IDENTITY_DAY_CHUNK_SIZE = maxChunkLength(
  CONTENT_IDENTITY_DAY_BINDS,
  CONTENT_IDENTITY_FIXED_BINDS,
);

function contentIdentityDayClause(days: readonly string[]): SQL {
  if (days.length === 0) {
    throw new Error("content-identity day lookup requires at least one day");
  }
  assertBindBudget(
    CONTENT_IDENTITY_FIXED_BINDS + days.length * CONTENT_IDENTITY_DAY_BINDS,
    "content-identity day lookup",
  );
  const ranges = days.map((day) =>
    and(gte(releases.publishedAt, day), lt(releases.publishedAt, nextDay(day)))!,
  );
  return ranges.length === 1 ? ranges[0]! : or(...ranges)!;
}

/**
 * Same-day identity SELECT for one source. Refuses a day list that would bind
 * more than D1 allows — callers chunk with {@link CONTENT_IDENTITY_DAY_CHUNK_SIZE}.
 */
export function contentIdentityDayQuery(db: AnyDb, sourceId: string, days: readonly string[]) {
  return db
    .select({
      url: releases.url,
      publishedAt: releases.publishedAt,
      version: releases.version,
      title: releases.title,
      content: releases.content,
      bodyHash: releases.bodyHash,
    })
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), contentIdentityDayClause(days)));
}

/**
 * Existing same-day identities for a source. Rows written before `body_hash`
 * existed are hashed from the stored title + content here, so a reworded
 * re-fetch still matches history. Day ranges are chunked: a busy source's
 * history is one `OR` per day, and an unchunked list overflows D1 at ~50 days.
 */
export async function selectExistingContentIdentities(
  db: AnyDb,
  sourceId: string,
  days: readonly string[],
): Promise<ContentIdentity[]> {
  const uniqueDays = [...new Set(days)];
  if (uniqueDays.length === 0) return [];
  const out: ContentIdentity[] = [];
  const chunks = chunkForBindBudget(
    uniqueDays,
    CONTENT_IDENTITY_DAY_BINDS,
    CONTENT_IDENTITY_FIXED_BINDS,
  );
  for (const chunk of chunks) {
    // oxlint-disable-next-line no-await-in-loop -- D1 bind-budget chunks
    const rows = await contentIdentityDayQuery(db, sourceId, chunk);
    for (const row of rows) {
      out.push({
        url: row.url,
        publishedAt: row.publishedAt,
        version: row.version,
        title: row.title,
        bodyHash: row.bodyHash ?? releaseBodyHash(row.content, row.title),
      });
    }
  }
  return out;
}

/**
 * Drop reworded same-day duplicates. Items without a hashable body or a day
 * pass through. Callers skip this in enrich mode, where a same-title re-POST
 * is the update being requested.
 */
export async function dropRewordedContentDuplicates<T extends DedupItem>(
  db: AnyDb,
  sourceId: string,
  items: T[],
): Promise<{ kept: Array<T & { bodyHash: string | null }>; dropped: number }> {
  const stamped = items.map((item) => ({
    ...item,
    bodyHash:
      item.bodyHash ??
      releaseBodyHash(typeof item.content === "string" ? item.content : "", item.title),
  }));
  const days = [
    ...new Set(
      stamped.map((item) => publishedDay(item.publishedAt)).filter((d): d is string => !!d),
    ),
  ];
  const existing = await selectExistingContentIdentities(db, sourceId, days);
  return dedupeByContentIdentity(stamped, existing);
}
