import { cache } from "react";
import { ApiNotFoundError } from "@/lib/api";
import { graphqlRequest } from "@/lib/graphql/client";
import { ProductDetailDocument } from "@/lib/graphql/__generated__/graphql";
import { mapProductDetail, type MappedProductDetail } from "@/lib/graphql/map-source";

/**
 * Product identity/description data, GraphQL-backed (#1978 slice 3). Takes a
 * product id (already resolved via REST `getResolved`, which stays the
 * slug→id lookup — see `_lib/resolve.ts`). The product's release feed,
 * overview, activity, heatmap, and collections stay on REST inside
 * `ProductView` — a cross-org feed + several independent AI/aggregate
 * sub-fetches, disproportionate to this slice. See PR description.
 */
export const getProductById = cache(async (id: string): Promise<MappedProductDetail> => {
  const data = await graphqlRequest(ProductDetailDocument, { id });
  if (!data.product) {
    throw new ApiNotFoundError(`No product ${id}`);
  }
  return mapProductDetail(data.product);
});
