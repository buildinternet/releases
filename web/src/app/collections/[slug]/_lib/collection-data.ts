import { cache } from "react";
import type {
  CollectionDailySummary,
  CollectionDetail,
  CollectionMember,
  CollectionReleaseItem,
  CollectionReleasesResponse,
} from "@/lib/api";
import { api, ApiNotFoundError } from "@/lib/api";
import { graphqlRequest } from "@/lib/graphql/client";
import { CollectionPageDocument } from "@/lib/graphql/__generated__/graphql";
import type { CollectionPageQuery } from "@/lib/graphql/__generated__/graphql";
import { mapMediaItems } from "@/lib/graphql/map-feed";

const DEFAULT_RELEASE_LIMIT = 20;

type GqlMember = NonNullable<NonNullable<CollectionPageQuery["collection"]>["members"]>[number];
type GqlRelease = NonNullable<
  NonNullable<CollectionPageQuery["collection"]>["releases"]
>["items"][number];

function mapMember(m: GqlMember): CollectionMember {
  if (m.__typename === "CollectionMemberProduct") {
    return {
      kind: "product",
      slug: m.slug,
      name: m.name,
      description: m.description,
      org: {
        slug: m.org.slug,
        name: m.org.name,
        domain: m.org.domain,
        avatarUrl: m.org.avatarUrl,
        githubHandle: m.org.githubHandle,
      },
    };
  }
  // CollectionMemberOrg (union default after product branch).
  return {
    kind: "org",
    slug: m.slug,
    name: m.name,
    domain: m.domain,
    avatarUrl: m.avatarUrl,
    githubHandle: m.githubHandle,
    description: m.description,
  };
}

function mapRelease(r: GqlRelease): CollectionReleaseItem {
  return {
    id: r.id,
    title: r.title,
    version: r.version,
    type: r.type as CollectionReleaseItem["type"],
    url: r.url,
    publishedAt: r.publishedAt,
    summary: r.summary,
    content: r.content,
    titleGenerated: r.titleGenerated,
    titleShort: r.titleShort,
    prerelease: r.prerelease,
    media: mapMediaItems(r.media),
    source: {
      slug: r.source.slug,
      name: r.source.name,
      type: r.source.type,
    },
    org: {
      slug: r.org.slug,
      name: r.org.name,
    },
    product: r.product ?? null,
    groupSlug: r.groupSlug ?? undefined,
    groupName: r.groupName ?? undefined,
    coverageCount: r.coverageCount,
    composition: r.composition
      ? {
          bugs: r.composition.bugs,
          features: r.composition.features,
          enhancements: r.composition.enhancements,
        }
      : null,
  };
}

export type CollectionPageData = {
  detail: CollectionDetail;
  releases: CollectionReleasesResponse;
  summaries: CollectionDailySummary[];
};

/**
 * Collection detail critical path via `CollectionPage` (#2047): identity +
 * members + first feed page + daily summaries. Client load-more stays on REST.
 *
 * Falls back to REST when GraphQL fails (#2056) — prefer degraded feed/summaries
 * over a hard 500; real 404s still surface as `ApiNotFoundError`.
 */
export const getCollectionPage = cache(async (slug: string): Promise<CollectionPageData> => {
  try {
    return await getCollectionPageGraphql(slug);
  } catch (err) {
    if (err instanceof ApiNotFoundError) throw err;
    console.warn(
      JSON.stringify({
        component: "web-ssr",
        event: "collection-page-graphql-fallback",
        route: `/collections/${slug}`,
        err: {
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
        },
      }),
    );
    return getCollectionPageRest(slug);
  }
});

async function getCollectionPageGraphql(slug: string): Promise<CollectionPageData> {
  const data = await graphqlRequest(CollectionPageDocument, {
    slug,
    releaseLimit: DEFAULT_RELEASE_LIMIT,
  });
  if (!data.collection) {
    throw new ApiNotFoundError(`/v1/collections/${slug}`);
  }
  const c = data.collection;
  const members = c.members.map(mapMember);
  return {
    detail: {
      slug: c.slug,
      name: c.name,
      description: c.description,
      isFeatured: c.isFeatured,
      dailySummaryEnabled: c.dailySummaryEnabled,
      members,
      // Legacy org-only subset for CollectionDetail back-compat.
      orgs: members
        .filter((m): m is Extract<CollectionMember, { kind: "org" }> => m.kind === "org")
        .map(({ kind: _k, ...rest }) => rest),
    },
    releases: {
      releases: c.releases.items.map(mapRelease),
      pagination: {
        nextCursor: c.releases.nextCursor,
        limit: DEFAULT_RELEASE_LIMIT,
      },
    },
    summaries: c.dailySummaries.map((s) => ({
      date: s.date,
      title: s.title,
      summary: s.summary,
      takeaways: s.takeaways,
      releaseCount: s.releaseCount,
    })),
  };
}

/** REST twin of CollectionPage — used when the persisted op fails or is missing. */
async function getCollectionPageRest(slug: string): Promise<CollectionPageData> {
  // Identity is primary; feed + summaries degrade to empty if those REST
  // routes fail independently (prefer partial page over 500).
  const [detail, releases, summariesRes] = await Promise.all([
    api.collectionDetail(slug),
    api.collectionReleases(slug, { limit: DEFAULT_RELEASE_LIMIT }).catch(
      (): CollectionReleasesResponse => ({
        releases: [],
        pagination: { nextCursor: null, limit: DEFAULT_RELEASE_LIMIT },
      }),
    ),
    api.collectionDailySummaries(slug).catch(() => ({ summaries: [] as CollectionDailySummary[] })),
  ]);

  return {
    detail,
    releases: {
      releases: releases.releases,
      pagination: {
        nextCursor: releases.pagination?.nextCursor ?? null,
        limit: releases.pagination?.limit ?? DEFAULT_RELEASE_LIMIT,
      },
    },
    summaries: summariesRes.summaries,
  };
}
