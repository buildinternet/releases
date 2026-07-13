import { cache } from "react";
import { api, ApiNotFoundError } from "@/lib/api";
import type {
  CollectionDetail,
  CollectionWeeklyDigestDetail,
  CollectionWeeklyDigestListItem,
} from "@/lib/api";

export type DigestPageData = {
  detail: CollectionDetail;
  digest: CollectionWeeklyDigestDetail;
};

/** Collection identity + one full digest row, resolved together so the
 *  detail page (breadcrumb needs the collection name) makes one round trip
 *  per data source. Throws `ApiNotFoundError` when either the collection or
 *  the week's digest doesn't exist — callers translate that to `notFound()`. */
export const getDigestPage = cache(
  async (slug: string, weekStart: string): Promise<DigestPageData> => {
    const [detail, digest] = await Promise.all([
      api.collectionDetail(slug),
      api.collectionWeeklyDigest(slug, weekStart),
    ]);
    return { detail, digest };
  },
);

export type DigestIndexData = {
  detail: CollectionDetail;
  digests: CollectionWeeklyDigestListItem[];
};

const DIGEST_INDEX_LIMIT = 50;

export const getDigestIndex = cache(async (slug: string): Promise<DigestIndexData> => {
  const [detail, digestsRes] = await Promise.all([
    api.collectionDetail(slug),
    api.collectionWeeklyDigests(slug, { limit: DIGEST_INDEX_LIMIT }),
  ]);
  return { detail, digests: digestsRes.digests };
});

/** How many recent digests the collection page right-rail surfaces. */
export const RECENT_DIGESTS_LIMIT = 3;

/**
 * Recent digests (newest-first). Fails soft to `[]` — a missing list is not
 * a 404 for the collection rail / cross-links. Non-404 errors are logged.
 */
export const getRecentDigests = cache(
  async (
    slug: string,
    limit: number = RECENT_DIGESTS_LIMIT,
  ): Promise<CollectionWeeklyDigestListItem[]> => {
    try {
      const res = await api.collectionWeeklyDigests(slug, { limit });
      return res.digests;
    } catch (err) {
      if (!(err instanceof ApiNotFoundError)) {
        console.error(`getRecentDigests(${slug}) failed`, err);
      }
      return [];
    }
  },
);

/** Latest digest, or `null` when none. Thin wrapper over {@link getRecentDigests}. */
export const getLatestDigest = cache(
  async (slug: string): Promise<CollectionWeeklyDigestListItem | null> => {
    const digests = await getRecentDigests(slug, 1);
    return digests[0] ?? null;
  },
);
