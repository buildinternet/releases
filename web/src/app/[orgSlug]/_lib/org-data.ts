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
 * branch, none of which are ported to GraphQL for this slice (#1978).
 */
export type OrgPageData = Omit<GqlOrg, "products" | "sources" | "locations" | "notice"> & {
  products: OrgPageProduct[];
  sources: SourceListItem[];
  locations?: ReleaseLocationItem[];
  notice?: Notice | null;
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
 * Primary org record + products + sources, fetched via one persisted GraphQL
 * query (`Query.org`) instead of the REST `GET /v1/orgs/:slug` round trip.
 * `overview` and stats-heavy REST-only aggregates the GraphQL schema doesn't
 * cover (org overview knowledge-page content, its citations, the playbook
 * scope) stay off this object — see `getOrgOverview`.
 */
export const getOrg = cache(async (slug: string): Promise<OrgPageData> => {
  const data = await graphqlRequest(OrgPageDocument, { idOrSlug: slug });
  if (!data.org) throw new ApiNotFoundError(`/v1/orgs/${slug}`);
  const { products, sources, locations, notice, ...rest } = data.org;
  return {
    ...rest,
    products: products.map(mapProduct),
    sources: sources.map(mapSource),
    locations: (locations as ReleaseLocationItem[] | null) ?? undefined,
    notice: notice as Notice | null,
  };
});

export const getOrgCollections = cache(async (slug: string): Promise<CollectionListItem[]> => {
  return api.orgCollections(slug).catch(() => [] as CollectionListItem[]);
});

/**
 * Org overview knowledge-page content (AI-generated summary + citations).
 * Deliberately left on REST (#1978 slice 2) — the REST projection joins
 * `knowledge_pages` with per-citation release rows and builds canonical
 * `releaseWebUrl`s server-side; porting that to a GraphQL resolver is a
 * separate, disproportionate lift for this pass. Only used by the org
 * overview page (`(org)/page.tsx`), not layout/releases/sources.
 */
export const getOrgOverview = cache(async (slug: string): Promise<OverviewPageItem | null> => {
  return api
    .orgDetail(slug)
    .then((o) => o.overview ?? null)
    .catch(() => null);
});
