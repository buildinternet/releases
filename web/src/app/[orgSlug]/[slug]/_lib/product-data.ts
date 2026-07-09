import { cache } from "react";
import type { OrgReleaseItem, CollectionListItem } from "@/lib/api";
import { api, ApiNotFoundError } from "@/lib/api";
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

export type ProductPageRef = {
  /** Typed product id (`prod_…`) — GraphQL lookup key. */
  id: string;
  orgSlug: string;
  productSlug: string;
};

/**
 * Product page critical path via the persisted `ProductPage` query (#2047):
 * product identity + sources + collections + first product-scoped feed page.
 * Activity, heatmap, and overview stay on fail-open REST inside ProductView.
 *
 * Falls back to REST when GraphQL fails (PersistedQueryNotFound deploy window,
 * resolver error, etc.) — same resilience pattern as `getOrgCollections`.
 * Takes a product id already resolved via REST `getResolved` (slug→id hop)
 * plus the slug pair for the REST path.
 */
export const getProductPage = cache(async (ref: ProductPageRef): Promise<ProductPageData> => {
  try {
    return await getProductPageGraphql(ref.id);
  } catch (err) {
    if (err instanceof ApiNotFoundError) throw err;
    console.warn(
      JSON.stringify({
        component: "web-ssr",
        event: "product-page-graphql-fallback",
        route: `/${ref.orgSlug}/${ref.productSlug}`,
        productId: ref.id,
        err: {
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
        },
      }),
    );
    return getProductPageRest(ref);
  }
});

/**
 * Product identity for admin / light consumers. Reuses the ProductPage critical
 * path (GraphQL + REST fallback) so admin doesn't hard-depend on a separate
 * ProductDetail op that was folded into ProductPage (#2047 / #2050).
 */
export const getProductById = cache(async (ref: ProductPageRef): Promise<MappedProductDetail> => {
  const page = await getProductPage(ref);
  return page.product;
});

async function getProductPageGraphql(id: string): Promise<ProductPageData> {
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
}

/** REST twin of ProductPage — used when the persisted op isn't on the API yet. */
async function getProductPageRest(ref: ProductPageRef): Promise<ProductPageData> {
  const productRef = { orgSlug: ref.orgSlug, productSlug: ref.productSlug };
  const [detail, collections, feed] = await Promise.all([
    api.productDetail(productRef),
    api.productCollections(productRef).catch(() => [] as CollectionListItem[]),
    api.orgReleases(ref.orgSlug, { product: ref.productSlug, limit: DEFAULT_RELEASE_LIMIT }),
  ]);

  const product: MappedProductDetail = {
    id: detail.id,
    slug: detail.slug,
    name: detail.name,
    url: detail.url,
    description: detail.description,
    category: detail.category,
    tags: detail.tags ?? [],
    notice: detail.notice ?? null,
    sources: (detail.sources ?? []).map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      type: s.type,
      url: s.url,
      metadata: s.metadata ?? null,
      // Bare product detail doesn't project isHidden; public product pages
      // only list attached sources the catalog already surfaces.
      isHidden: false,
    })),
  };

  return {
    product,
    collections,
    releases: {
      releases: feed.releases,
      pagination: {
        nextCursor: feed.pagination?.nextCursor ?? null,
        limit: feed.pagination?.limit ?? DEFAULT_RELEASE_LIMIT,
      },
    },
  };
}
