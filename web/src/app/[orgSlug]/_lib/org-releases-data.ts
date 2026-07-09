import { cache } from "react";
import type { OrgReleaseItem } from "@buildinternet/releases-api-types";
import { api, ApiNotFoundError } from "@/lib/api";
import { graphqlRequest } from "@/lib/graphql/client";
import { OrgReleasesDocument } from "@/lib/graphql/__generated__/graphql";
import { mapOrgReleaseItem } from "@/lib/graphql/map-feed";

/**
 * Org release feed via the persisted `OrgReleases` GraphQL query
 * (`Query.latestReleases(orgIdOrSlug:)`). SSR initial page only — client
 * "load more" stays on `/api/org-releases/[orgSlug]` (REST).
 *
 * Falls back to REST when GraphQL fails — same pattern as ProductPage
 * (#2054 / #2056). Real 404s rethrow; empty feed is acceptable degraded mode
 * only if the REST path itself soft-fails after the GraphQL warn.
 */
export const getOrgReleases = cache(
  async (
    orgSlug: string,
    limit = 20,
  ): Promise<{ releases: OrgReleaseItem[]; nextCursor: string | null }> => {
    try {
      return await getOrgReleasesGraphql(orgSlug, limit);
    } catch (err) {
      if (err instanceof ApiNotFoundError) throw err;
      console.warn(
        JSON.stringify({
          component: "web-ssr",
          event: "org-releases-graphql-fallback",
          route: `/${orgSlug}/releases`,
          err: {
            message: err instanceof Error ? err.message : String(err),
            name: err instanceof Error ? err.name : undefined,
          },
        }),
      );
      return getOrgReleasesRest(orgSlug, limit);
    }
  },
);

async function getOrgReleasesGraphql(
  orgSlug: string,
  limit: number,
): Promise<{ releases: OrgReleaseItem[]; nextCursor: string | null }> {
  const data = await graphqlRequest(OrgReleasesDocument, { orgIdOrSlug: orgSlug, limit });
  return {
    releases: data.latestReleases.items.map(mapOrgReleaseItem),
    nextCursor: data.latestReleases.nextCursor,
  };
}

async function getOrgReleasesRest(
  orgSlug: string,
  limit: number,
): Promise<{ releases: OrgReleaseItem[]; nextCursor: string | null }> {
  const feed = await api.orgReleases(orgSlug, { limit });
  return {
    releases: feed.releases,
    nextCursor: feed.pagination?.nextCursor ?? null,
  };
}
