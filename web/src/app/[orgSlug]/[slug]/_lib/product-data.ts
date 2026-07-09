import { cache } from "react";
import type { OrgReleaseItem, CollectionListItem } from "@/lib/api";
import { ApiNotFoundError } from "@/lib/api";
import { graphqlRequest } from "@/lib/graphql/client";
import { ProductPageDocument } from "@/lib/graphql/__generated__/graphql";
import { mapProductDetail, type MappedProductDetail } from "@/lib/graphql/map-source";
import {
  buildRestFeedCursor,
  mapCollectionListItem,
  mapOrgReleaseItem,
} from "@/lib/graphql/map-feed";

const DEFAULT_RELEASE_LIMIT = 20;

export type ProductPageData = {
  product: MappedProductDetail;
  collections: CollectionListItem[];
  releases: {
    releases: OrgReleaseItem[];
    pagination: { nextCursor: string | null; limit: number };
  };
};

/**
 * Product page critical path via the persisted `ProductPage` query (#2047):
 * product identity + sources + collections + first product-scoped feed page.
 * Activity, heatmap, and overview stay on fail-open REST inside ProductView.
 *
 * Takes a product id already resolved via REST `getResolved` (slug→id hop).
 */
export const getProductPage = cache(async (id: string): Promise<ProductPageData> => {
  // Overfetch by one so we can derive a REST-compatible nextCursor without a
  // second query (same limit+1 trick as SourceDetail / REST org feed).
  const data = await graphqlRequest(ProductPageDocument, {
    id,
    releaseLimit: DEFAULT_RELEASE_LIMIT + 1,
  });
  if (!data.product) {
    throw new ApiNotFoundError(`No product ${id}`);
  }

  const items = data.latestReleases.items;
  const hasMore = items.length > DEFAULT_RELEASE_LIMIT;
  const pageRows = hasMore ? items.slice(0, DEFAULT_RELEASE_LIMIT) : items;
  const last = pageRows[pageRows.length - 1];

  return {
    product: mapProductDetail(data.product),
    collections: data.product.collections.map(mapCollectionListItem),
    releases: {
      releases: pageRows.map(mapOrgReleaseItem),
      pagination: {
        nextCursor: hasMore && last ? buildRestFeedCursor(last) : null,
        limit: DEFAULT_RELEASE_LIMIT,
      },
    },
  };
});
