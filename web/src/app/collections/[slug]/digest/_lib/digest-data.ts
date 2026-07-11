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

/** Latest digest for a collection, or `null` when none exist yet. Used by the
 *  collection page + `/collections` index cross-links — fails soft (empty)
 *  rather than throwing, since a missing digest list is not a 404 condition
 *  for those pages. */
export const getLatestDigest = cache(
  async (slug: string): Promise<CollectionWeeklyDigestListItem | null> => {
    try {
      const res = await api.collectionWeeklyDigests(slug, { limit: 1 });
      return res.digests[0] ?? null;
    } catch (err) {
      if (err instanceof ApiNotFoundError) return null;
      return null;
    }
  },
);
