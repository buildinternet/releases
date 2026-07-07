import { cache } from "react";
import type { OrgReleaseItem } from "@buildinternet/releases-api-types";
import { graphqlRequest } from "@/lib/graphql/client";
import { OrgReleasesDocument } from "@/lib/graphql/__generated__/graphql";
import type { OrgReleasesQuery } from "@/lib/graphql/__generated__/graphql";

type GqlOrgReleaseItem = OrgReleasesQuery["latestReleases"]["items"][number];

function mapReleaseItem(r: GqlOrgReleaseItem): OrgReleaseItem {
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
 * Org release feed via the persisted `OrgReleases` GraphQL query
 * (`Query.latestReleases(orgIdOrSlug:)`) instead of REST
 * `GET /v1/orgs/:slug/releases`. Only backs the SSR initial page — the
 * client-side "load more" pagination in `org-release-list.tsx` still calls
 * the `/api/org-releases/[orgSlug]` REST-backed route handler (unchanged,
 * out of scope for this slice).
 */
export const getOrgReleases = cache(
  async (
    orgSlug: string,
    limit = 20,
  ): Promise<{ releases: OrgReleaseItem[]; nextCursor: string | null }> => {
    const data = await graphqlRequest(OrgReleasesDocument, { orgIdOrSlug: orgSlug, limit });
    return {
      releases: data.latestReleases.items.map(mapReleaseItem),
      nextCursor: data.latestReleases.nextCursor,
    };
  },
);
