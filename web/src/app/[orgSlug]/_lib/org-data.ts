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
import { OrgPageDocument, OrgCollectionsDocument } from "@/lib/graphql/__generated__/graphql";
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
 * (`@buildinternet/releases-api-types`) MINUS `overview`, `playbook`, and
 * `collections` — overview stays on the thin REST route (`getOrgOverview`);
 * collections are a separate persisted op (`getOrgCollections`) so the
 * OrgPage document hash stays stable across deploy windows (#2047).
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
 * Primary org record + products + sources via the stable `OrgPage` persisted
 * query. Collections and overview are separate (see `getOrgCollections` /
 * `getOrgOverview`) so this hash can ship without a coordinated API deploy.
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

/**
 * Collections for the org sidebar. Prefers GraphQL `OrgCollections` (additive
 * #2047 field on Query.org); falls back to REST when the persisted op isn't
 * on the API yet (PR preview / deploy window).
 */
export const getOrgCollections = cache(async (slug: string): Promise<CollectionListItem[]> => {
  try {
    const data = await graphqlRequest(OrgCollectionsDocument, { idOrSlug: slug });
    return (data.org?.collections ?? []).map(mapCollectionListItem);
  } catch {
    return api.orgCollections(slug).catch(() => [] as CollectionListItem[]);
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
