import { and, eq, sql } from "drizzle-orm";
import type { createDb } from "../db.js";
import { organizationsActive, sources, sourcesActive } from "@buildinternet/releases-core/schema";
import { newSourceId } from "@buildinternet/releases-core/id";
import { toSlug } from "@buildinternet/releases-core/slug";
import { matchVideoUrl, fetchAndParseVideoFeed } from "@releases/adapters/video";
import { ingestRawReleases, type FetchOneEnv } from "../cron/poll-fetch.js";

export interface MaterializeVideoParams {
  url: string;
  orgSlug?: string;
  orgId?: string;
  productId?: string;
  /** Test seam: override the fetch implementation. */
  fetchImpl?: typeof fetch;
}

export type MaterializeVideoResult =
  | { status: "bad_request" }
  | { status: "org_not_found" }
  | { status: "feed_unavailable" }
  | {
      status: "indexed" | "existing";
      source: typeof sources.$inferSelect;
      releaseCount: number;
    };

async function ensureUniqueSourceSlug(
  db: ReturnType<typeof createDb>,
  orgId: string,
  base: string,
): Promise<string> {
  const root = base || "video";
  // Query the base `sources` table (not the active view) so soft-deleted rows
  // that still occupy the unique index (idx_sources_org_slug: UNIQUE(org_id, slug),
  // no partial WHERE clause) are accounted for. Bounded so a pathological run of
  // collisions can't loop forever; the suffix falls back to the source id range.
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? root : `${root}-${n}`;
    const [hit] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.orgId, orgId), eq(sources.slug, candidate)))
      .limit(1);
    if (!hit) return candidate;
  }
  // 50 same-named sources in one org is implausible; fall back to a unique id.
  return `${root}-${newSourceId()}`;
}

const MARKETING_HINT =
  "Suppress customer case studies, customer testimonials, event recaps, and partner spotlights; keep first-party product launches and feature announcements.";

/**
 * Resolve a YouTube channel/playlist URL and materialize a curated
 * Org → Source → backfilled Releases under the given org.
 *
 * Key differences from `materializeAppStoreSource`:
 * - Org is **required** (no derivation from feed metadata per #690).
 * - Backfill runs through `ingestRawReleases` so the marketing classifier,
 *   summarizer-trigger, and dedup all apply to the initial batch.
 * - Idempotent on the resolved feedUrl (a `video` source in the same org
 *   with the same `metadata.feedUrl` wins).
 */
export async function materializeVideoSource(
  db: ReturnType<typeof createDb>,
  env: FetchOneEnv,
  params: MaterializeVideoParams,
): Promise<MaterializeVideoResult> {
  // 1. Provider match — reject non-video URLs early.
  const provider = matchVideoUrl(params.url);
  if (!provider) return { status: "bad_request" };

  // 2. Resolve the feed URL from the human URL (pure for playlist/channel-id,
  //    requires a network fetch for @handle URLs).
  let resolved;
  try {
    resolved = await provider.resolveFeed(params.url, params.fetchImpl);
  } catch {
    return { status: "bad_request" };
  }

  // 3. Resolve the org (required — no derivation from feed).
  const orgRows = params.orgId
    ? await db
        .select()
        .from(organizationsActive)
        .where(eq(organizationsActive.id, params.orgId))
        .limit(1)
    : params.orgSlug
      ? await db
          .select()
          .from(organizationsActive)
          .where(eq(organizationsActive.slug, params.orgSlug.toLowerCase()))
          .limit(1)
      : [];
  const org = orgRows[0];
  if (!org) return { status: "org_not_found" };

  // 4. Idempotency: existing video source in this org with the same feedUrl wins.
  const existingRows = await db
    .select()
    .from(sourcesActive)
    .where(
      and(
        eq(sourcesActive.orgId, org.id),
        eq(sourcesActive.type, "video"),
        sql`json_extract(${sourcesActive.metadata}, '$.feedUrl') = ${resolved.feedUrl}`,
      ),
    )
    .limit(1);
  if (existingRows.length > 0) {
    return {
      status: "existing",
      source: existingRows[0]! as typeof sources.$inferSelect,
      releaseCount: 0,
    };
  }

  // 5. Fetch + parse the feed once: fills channel identity for naming +
  //    supplies the initial backfill batch.
  let parsed;
  try {
    parsed = await fetchAndParseVideoFeed(resolved.feedUrl, provider, undefined, params.fetchImpl);
  } catch {
    return { status: "feed_unavailable" };
  }
  const channel = { ...resolved.channel, ...parsed.channel };

  const channelTitle = channel.playlistTitle ?? channel.title;
  const displayName = channelTitle ?? "Video channel";
  const baseSlug = toSlug(channelTitle ?? channel.id ?? "video").toLowerCase();
  const sourceSlug = await ensureUniqueSourceSlug(db, org.id, baseSlug);

  const sourceId = newSourceId();
  // Seed both conditional-GET validators so the first cron poll can short-circuit
  // an unchanged feed regardless of whether the server uses ETag or Last-Modified.
  // (undefined keys are dropped by JSON.stringify.)
  const metadata = JSON.stringify({
    feedUrl: resolved.feedUrl,
    feedType: "atom",
    feedEtag: parsed.etag ?? undefined,
    feedLastModified: parsed.lastModified ?? undefined,
    video: { provider: provider.id, channel },
    marketingFilter: true,
    marketingFilterHint: MARKETING_HINT,
  });

  const [insertedSource] = await db
    .insert(sources)
    .values({
      id: sourceId,
      name: displayName,
      slug: sourceSlug,
      type: "video",
      url: resolved.canonicalUrl,
      orgId: org.id,
      productId: params.productId ?? null,
      discovery: "curated",
      isHidden: false,
      metadata,
    })
    .returning();

  // 6. Backfill through the shared ingest path so the marketing classifier +
  //    summarizer-trigger + dedup all apply to the initial batch.
  //    Fail-open: if ANTHROPIC_API_KEY is absent the classifier returns an
  //    empty Map and all items are inserted visibly.
  const ingest = await ingestRawReleases(
    db,
    insertedSource! as typeof sources.$inferSelect,
    parsed.releases,
    env,
  );

  return {
    status: "indexed",
    source: insertedSource! as typeof sources.$inferSelect,
    releaseCount: ingest.inserted,
  };
}
