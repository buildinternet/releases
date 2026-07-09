import { cache } from "react";
import type {
  CollectionListItem,
  OverviewPageItem,
  ReleaseLocationItem,
  SourceListItem,
} from "@buildinternet/releases-api-types";
import type { Notice } from "@buildinternet/releases-core/notice";
import type { Kind } from "@buildinternet/releases-core/kinds";
import { api, ApiNotFoundError } from "@/lib/api";
import { graphqlRequest } from "@/lib/graphql/client";
import { OrgPageDocument } from "@/lib/graphql/__generated__/graphql";
import type { OrgPageQuery } from "@/lib/graphql/__generated__/graphql";
import { mapCollectionListItem } from "@/lib/graphql/map-feed";

type GqlOrg = NonNullable<OrgPageQuery["org"]>;
type GqlOrgSource = GqlOrg["sources"][number];
type GqlOrgProduct = GqlOrg["products"][number];

/**
 * Product shape used across org pages — mirrors the REST `OrgDetail.products`
 * projection (id/slug/name/url/description/sourceCount/kind/createdAt plus
 * releaseCount).
 */
export type OrgPageProduct = {
  id: string;
  slug: string;
  name: string;
  url: string | null;
  description: string | null;
  sourceCount: number;
  kind: Kind | null;
  createdAt: string;
  releaseCount: number;
};

/**
 * Org detail used by the org page family. Field set matches `OrgDetail`
 * (`@buildinternet/releases-api-types`) MINUS `overview` and `playbook` —
 * those stay on REST (see `getOrgOverview` below): the overview knowledge-page
 * projection joins `knowledge_pages` + citation rows + a playbook-only auth
 * branch, none of which are ported to GraphQL for this slice (#1978 / #2047).
 *
 * `collections` is nested on the OrgPage GraphQL op (#2047) so the layout no
 * longer needs a second REST hop for the sidebar.
 */
export type OrgPageData = Omit<
  GqlOrg,
  "products" | "sources" | "locations" | "notice" | "collections"
> & {
  products: OrgPageProduct[];
  sources: SourceListItem[];
  locations?: ReleaseLocationItem[];
  notice?: Notice | null;
  collections: CollectionListItem[];
};

function mapSource(s: GqlOrgSource): SourceListItem {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    type: s.type,
    url: s.url,
    releaseCount: s.releaseCount,
    latestVersion: s.latestVersion,
    latestDate: s.latestDate,
    latestAddedAt: s.latestAddedAt,
    isPrimary: s.isPrimary ?? undefined,
    isHidden: s.isHidden ?? undefined,
    discovery: (s.discovery as SourceListItem["discovery"]) ?? undefined,
    fetchPriority: (s.fetchPriority as SourceListItem["fetchPriority"]) ?? null,
    lastFetchedAt: s.lastFetchedAt,
    lastPolledAt: s.lastPolledAt,
    changeDetectedAt: s.changeDetectedAt,
    consecutiveNoChange: s.consecutiveNoChange,
    consecutiveErrors: s.consecutiveErrors,
    nextFetchAfter: s.nextFetchAfter,
    medianGapDays: s.medianGapDays,
    lastRetieredAt: s.lastRetieredAt,
    metadata: s.metadata,
    productName: s.product?.name ?? null,
    productSlug: s.product?.slug ?? null,
    kind: (s.kind as SourceListItem["kind"]) ?? null,
    stars: s.stars,
    starsFetchedAt: s.starsFetchedAt,
  };
}

function mapProduct(p: GqlOrgProduct): OrgPageProduct {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    url: p.url,
    description: p.description,
    sourceCount: p.sourceCount,
    kind: (p.kind as Kind | null) ?? null,
    createdAt: p.createdAt,
    releaseCount: p.releaseCount,
  };
}

/**
 * Primary org record + products + sources + collections, fetched via one
 * persisted GraphQL query (`Query.org`) instead of REST
 * `GET /v1/orgs/:slug` + `GET /v1/orgs/:slug/collections`. Overview stays on
 * the thin REST overview route — see `getOrgOverview`.
 */
export const getOrg = cache(async (slug: string): Promise<OrgPageData> => {
  const data = await graphqlRequest(OrgPageDocument, { idOrSlug: slug });
  if (!data.org) throw new ApiNotFoundError(`/v1/orgs/${slug}`);
  const { products, sources, locations, notice, collections, ...rest } = data.org;
  return {
    ...rest,
    products: products.map(mapProduct),
    sources: sources.map(mapSource),
    locations: (locations as ReleaseLocationItem[] | null) ?? undefined,
    notice: notice as Notice | null,
    collections: collections.map(mapCollectionListItem),
  };
});

/** Collections for the org sidebar — already on the OrgPage GraphQL response. */
export const getOrgCollections = cache(async (slug: string): Promise<CollectionListItem[]> => {
  try {
    const org = await getOrg(slug);
    return org.collections;
  } catch {
    return [];
  }
});

/**
 * Org overview knowledge-page content (AI-generated summary + citations).
 * Uses the thin REST `GET /v1/orgs/:slug/overview` — not the full orgDetail
 * shell (#2047). Only used by the org overview page and `/updates`.
 */
export const getOrgOverview = cache(async (slug: string): Promise<OverviewPageItem | null> => {
  return api.orgOverview(slug).catch(() => null);
});
