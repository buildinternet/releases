import { cache } from "react";
import type { OrgReleaseItem } from "@buildinternet/releases-api-types";
import { api, ApiNotFoundError } from "@/lib/api";
import { graphqlRequest } from "@/lib/graphql/client";
import { OrgReleasesDocument } from "@/lib/graphql/__generated__/graphql";
import { buildRestFeedCursor, mapOrgReleaseItem } from "@/lib/graphql/map-feed";

/**
 * Org release feed via the persisted `OrgReleases` GraphQL query
 * (`Query.latestReleases(orgIdOrSlug:)`). SSR initial page only — client
 * "load more" stays on `/api/org-releases/[orgSlug]` (REST).
 *
 * Falls back to REST when GraphQL fails — same pattern as ProductPage
 * (#2054 / #2056). Real 404s rethrow. If REST also fails after the GraphQL
 * warn, degrade to an empty feed (page chrome still renders).
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
      try {
        return await getOrgReleasesRest(orgSlug, limit);
      } catch (restErr) {
        console.warn(
          JSON.stringify({
            component: "web-ssr",
            event: "org-releases-rest-fallback-empty",
            route: `/${orgSlug}/releases`,
            err: {
              message: restErr instanceof Error ? restErr.message : String(restErr),
              name: restErr instanceof Error ? restErr.name : undefined,
            },
          }),
        );
        return { releases: [], nextCursor: null };
      }
    }
  },
);

async function getOrgReleasesGraphql(
  orgSlug: string,
  limit: number,
): Promise<{ releases: OrgReleaseItem[]; nextCursor: string | null }> {
  const data = await graphqlRequest(OrgReleasesDocument, { orgIdOrSlug: orgSlug, limit });
  const releases = data.latestReleases.items.map(mapOrgReleaseItem);
  // Client load-more pages via REST, whose cursor is the transparent
  // `publishedAt|fetchedAt|id` shape — the GraphQL token is opaque and REST's
  // parser fails open to page 1 on it. Rebuild from the last row, same as
  // product-data.ts / map-source.ts.
  const last = data.latestReleases.items.at(-1);
  return {
    releases,
    nextCursor: data.latestReleases.nextCursor && last ? buildRestFeedCursor(last) : null,
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
