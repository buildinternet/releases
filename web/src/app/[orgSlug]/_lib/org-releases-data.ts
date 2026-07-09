import { cache } from "react";
import type { OrgReleaseItem } from "@buildinternet/releases-api-types";
import { graphqlRequest } from "@/lib/graphql/client";
import { OrgReleasesDocument } from "@/lib/graphql/__generated__/graphql";
import { mapOrgReleaseItem } from "@/lib/graphql/map-feed";

/**
 * Org release feed via the persisted `OrgReleases` GraphQL query
 * (`Query.latestReleases(orgIdOrSlug:)`). SSR initial page only — client
 * "load more" stays on `/api/org-releases/[orgSlug]` (REST).
 */
export const getOrgReleases = cache(
  async (
    orgSlug: string,
    limit = 20,
  ): Promise<{ releases: OrgReleaseItem[]; nextCursor: string | null }> => {
    const data = await graphqlRequest(OrgReleasesDocument, { orgIdOrSlug: orgSlug, limit });
    return {
      releases: data.latestReleases.items.map(mapOrgReleaseItem),
      nextCursor: data.latestReleases.nextCursor,
    };
  },
);
