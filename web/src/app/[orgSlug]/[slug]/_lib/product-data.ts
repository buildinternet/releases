import { cache } from "react";
import type { OrgReleaseItem, CollectionListItem } from "@/lib/api";
import { ApiNotFoundError } from "@/lib/api";
import { graphqlRequest } from "@/lib/graphql/client";
import { ProductPageDocument } from "@/lib/graphql/__generated__/graphql";
import type { ProductPageQuery } from "@/lib/graphql/__generated__/graphql";
import { mapProductDetail, type MappedProductDetail } from "@/lib/graphql/map-source";

const DEFAULT_RELEASE_LIMIT = 20;

type GqlProductRelease = ProductPageQuery["latestReleases"]["items"][number];

/**
 * Map a GraphQL product-feed release onto the OrgReleaseItem shape
 * OrgReleaseList already consumes. Same field mapping as org-releases-data.
 */
function mapReleaseItem(r: GqlProductRelease): OrgReleaseItem {
  return {
    id: r.id,
    version: r.version,
    title: r.title,
    summary: r.summary ?? "",
    content: r.content,
    publishedAt: r.publishedAt,
    fetchedAt: r.fetchedAt,
    url: r.url,
    media: r.media.map((m) => ({
      type: m.type,
      url: m.url,
      alt: m.alt ?? undefined,
      r2Url: m.r2Url ?? undefined,
    })),
    type: r.type,
    prerelease: r.prerelease ?? undefined,
    titleGenerated: r.titleGenerated,
    titleShort: r.titleShort,
    breaking: (r.breaking as OrgReleaseItem["breaking"]) ?? undefined,
    source: {
      slug: r.source.slug,
      name: r.source.name,
      type: r.source.type,
      appStore: r.source.appStore ?? undefined,
      video: r.source.video ?? undefined,
    },
    product: r.source.product ?? null,
  };
}

/**
 * REST-compatible feed cursor (`publishedAt|fetchedAt|id`) so client-side
 * load-more on `/api/org-releases/...` keeps working after GraphQL SSR.
 * GraphQL's own nextCursor is base64url `publishedAt|id` and is not handed
 * to REST. Mirrors the source-page overfetch approach in map-source.ts.
 */
function buildRestFeedCursor(last: {
  publishedAt: string | null;
  fetchedAt: string;
  id: string;
}): string {
  return `${last.publishedAt ?? ""}|${last.fetchedAt}|${last.id}`;
}

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
 * Activity, heatmap, and overview stay on fail-open REST inside ProductView
 * (independent SLAs / cost profiles — see issue #2047).
 *
 * Takes a product id already resolved via REST `getResolved` (slug→id hop;
 * optional schema work for org+slug product lookup is a later item on #2047).
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

  const product = mapProductDetail(data.product);
  const collections: CollectionListItem[] = data.product.collections.map((c) => ({
    slug: c.slug,
    name: c.name,
    description: c.description,
    memberCount: c.memberCount,
    isFeatured: c.isFeatured,
  }));

  const items = data.latestReleases.items;
  const hasMore = items.length > DEFAULT_RELEASE_LIMIT;
  const pageRows = hasMore ? items.slice(0, DEFAULT_RELEASE_LIMIT) : items;
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? buildRestFeedCursor(last) : null;

  return {
    product,
    collections,
    releases: {
      releases: pageRows.map(mapReleaseItem),
      pagination: { nextCursor, limit: DEFAULT_RELEASE_LIMIT },
    },
  };
});
