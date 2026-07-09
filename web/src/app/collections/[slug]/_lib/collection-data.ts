import { cache } from "react";
import type {
  CollectionDailySummary,
  CollectionDetail,
  CollectionMember,
  CollectionReleaseItem,
  CollectionReleasesResponse,
} from "@/lib/api";
import { ApiNotFoundError } from "@/lib/api";
import { graphqlRequest } from "@/lib/graphql/client";
import { CollectionPageDocument } from "@/lib/graphql/__generated__/graphql";
import type { CollectionPageQuery } from "@/lib/graphql/__generated__/graphql";

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
  // CollectionMemberOrg (or unexpected — treat as org for fail-soft).
  return {
    kind: "org",
    slug: m.slug,
    name: m.name,
    domain: "domain" in m ? m.domain : null,
    avatarUrl: "avatarUrl" in m ? m.avatarUrl : null,
    githubHandle: "githubHandle" in m ? m.githubHandle : null,
    description: "description" in m ? m.description : null,
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
    media: r.media.map((m) => ({
      type: m.type,
      url: m.url,
      alt: m.alt ?? undefined,
      r2Url: m.r2Url ?? undefined,
    })),
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
 * Collection detail critical path via the persisted `CollectionPage` query
 * (#2047): identity + full members + first feed page + daily summaries.
 * Client load-more stays on REST (`/api/collection-releases/...`).
 */
export const getCollectionPage = cache(async (slug: string): Promise<CollectionPageData> => {
  // Overfetch by one so we can derive nextCursor when GraphQL returns a full
  // page; the resolver also does limit+1 and returns nextCursor, so either
  // path works — prefer the server-provided REST-compatible cursor.
  const data = await graphqlRequest(CollectionPageDocument, {
    slug,
    releaseLimit: DEFAULT_RELEASE_LIMIT,
  });
  if (!data.collection) {
    throw new ApiNotFoundError(`/v1/collections/${slug}`);
  }
  const c = data.collection;
  const members = c.members.map(mapMember);
  const detail: CollectionDetail = {
    slug: c.slug,
    name: c.name,
    description: c.description,
    isFeatured: c.isFeatured,
    dailySummaryEnabled: c.dailySummaryEnabled,
    members,
    // Legacy org-only subset for back-compat with CollectionDetail schema.
    orgs: members
      .filter((m): m is Extract<CollectionMember, { kind: "org" }> => m.kind === "org")
      .map(({ kind: _k, ...rest }) => rest),
  };
  const releases: CollectionReleasesResponse = {
    releases: c.releases.items.map(mapRelease),
    pagination: {
      nextCursor: c.releases.nextCursor,
      limit: DEFAULT_RELEASE_LIMIT,
    },
  };
  const summaries: CollectionDailySummary[] = c.dailySummaries.map((s) => ({
    date: s.date,
    title: s.title,
    summary: s.summary,
    takeaways: s.takeaways,
    releaseCount: s.releaseCount,
  }));
  return { detail, releases, summaries };
});
