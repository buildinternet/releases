/* eslint-disable */
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> =
  | T
  | { [P in keyof T]?: P extends " $fragmentName" | "__typename" ? T[P] : never };
import { TypedDocumentNode as DocumentNode } from "@graphql-typed-document-node/core";
/** App Store platform for an appstore source. */
export type AppStorePlatform = "ios" | "macos";

/** Kind of media attached to a release. */
export type MediaKind = "gif" | "image" | "video";

/** How an organization entered the registry: hand-curated, materialized by the discovery agent, or created on-demand via /v1/lookups. */
export type OrgDiscovery = "agent" | "curated" | "on_demand";

/** Org tier (#1947): `stub` has no processed sources yet (declared locations only); `tracked` is a normal org whose sources fetch and process. */
export type OrgStatus = "stub" | "tracked";

/** Whether a release is a normal feature/changelog entry or a seasonal/quarterly rollup catch-all. */
export type ReleaseType = "feature" | "rollup";

/** How a source is ingested: GitHub releases API, scraped HTML, parsed feed, or AI agent. */
export type SourceType = "agent" | "appstore" | "feed" | "github" | "scrape" | "video";

/** Provider for a video source. */
export type VideoProvider = "vimeo" | "wistia" | "youtube";

export type CollectionPageQueryVariables = Exact<{
  slug: string;
  releaseLimit: number;
}>;

export type CollectionPageQuery = {
  collection: {
    slug: string;
    name: string;
    description: string | null;
    isFeatured: boolean;
    dailySummaryEnabled: boolean;
    members: Array<
      | {
          __typename: "CollectionMemberOrg";
          slug: string;
          name: string;
          domain: string | null;
          avatarUrl: string | null;
          githubHandle: string | null;
          description: string | null;
        }
      | {
          __typename: "CollectionMemberProduct";
          slug: string;
          name: string;
          description: string | null;
          org: {
            slug: string;
            name: string;
            domain: string | null;
            avatarUrl: string | null;
            githubHandle: string | null;
          };
        }
    >;
    releases: {
      nextCursor: string | null;
      items: Array<{
        id: string;
        title: string;
        version: string | null;
        type: string;
        url: string | null;
        publishedAt: string | null;
        summary: string;
        content: string;
        titleGenerated: string | null;
        titleShort: string | null;
        prerelease: boolean;
        groupSlug: string;
        groupName: string;
        coverageCount: number;
        media: Array<{ type: MediaKind; url: string; alt: string | null; r2Url: string | null }>;
        source: { slug: string; name: string; type: string };
        org: { slug: string; name: string };
        product: { slug: string; name: string } | null;
        composition: { bugs: number; features: number; enhancements: number } | null;
      }>;
    };
    dailySummaries: Array<{
      date: string;
      title: string;
      summary: string;
      takeaways: Array<string>;
      releaseCount: number;
    }>;
  } | null;
};

export type HomepageAllOrgsQueryVariables = Exact<{
  limit: number;
}>;

export type HomepageAllOrgsQuery = {
  orgs: {
    items: Array<{
      slug: string;
      name: string;
      domain: string | null;
      avatarUrl: string | null;
      sourceCount: number;
      releaseCount: number;
      recentReleaseCount: number;
      lastActivity: string | null;
      topProducts: Array<string>;
      sparkline: Array<number>;
    }>;
  };
};

export type HomepageCollectionsQueryVariables = Exact<{
  featured?: boolean | null | undefined;
}>;

export type HomepageCollectionsQuery = {
  collections: Array<{
    slug: string;
    name: string;
    description: string | null;
    memberCount: number;
    isFeatured: boolean;
    previewMembers: Array<
      | {
          __typename: "CollectionMemberOrg";
          slug: string;
          name: string;
          avatarUrl: string | null;
          githubHandle: string | null;
        }
      | {
          __typename: "CollectionMemberProduct";
          slug: string;
          name: string;
          org: {
            slug: string;
            name: string;
            avatarUrl: string | null;
            githubHandle: string | null;
          };
        }
    >;
  }>;
};

export type HomepageOrgsStatsQueryVariables = Exact<{
  featuredLimit: number;
}>;

export type HomepageOrgsStatsQuery = {
  stats: { orgs: number; sources: number; releases: number };
  featuredOrgs: {
    items: Array<{
      slug: string;
      name: string;
      domain: string | null;
      avatarUrl: string | null;
      sourceCount: number;
      releaseCount: number;
      recentReleaseCount: number;
      lastActivity: string | null;
      topProducts: Array<string>;
      sparkline: Array<number>;
    }>;
  };
};

export type HomepageTickerQueryVariables = Exact<{
  limit: number;
  exclude: Array<SourceType> | SourceType;
}>;

export type HomepageTickerQuery = {
  latestReleases: {
    items: Array<{
      id: string;
      title: string;
      version: string | null;
      publishedAt: string | null;
      titleGenerated: string | null;
      titleShort: string | null;
      media: Array<{ type: MediaKind; url: string; alt: string | null; r2Url: string | null }>;
      source: {
        org: { slug: string; name: string; avatarUrl: string | null };
        product: { slug: string; name: string } | null;
        appStore: { platform: AppStorePlatform; iconUrl: string | null } | null;
        video: { provider: VideoProvider } | null;
      };
    }>;
  };
};

export type OrgCollectionsQueryVariables = Exact<{
  idOrSlug: string;
}>;

export type OrgCollectionsQuery = {
  org: {
    collections: Array<{
      slug: string;
      name: string;
      description: string | null;
      memberCount: number;
      isFeatured: boolean;
    }>;
  } | null;
};

export type OrgPageQueryVariables = Exact<{
  idOrSlug: string;
}>;

export type OrgPageQuery = {
  org: {
    id: string;
    slug: string;
    name: string;
    domain: string | null;
    description: string | null;
    category: string | null;
    avatarUrl: string | null;
    isHidden: boolean;
    autoGenerateContent: boolean | null;
    overviewCadenceDays: number | null;
    featured: boolean | null;
    fetchPaused: boolean | null;
    discovery: OrgDiscovery;
    status: OrgStatus;
    locations: unknown;
    tags: Array<string>;
    aliases: Array<string>;
    notice: unknown;
    sourceCount: number;
    releaseCount: number;
    releasesLast30Days: number;
    avgReleasesPerWeek: number;
    lastFetchedAt: string | null;
    lastPolledAt: string | null;
    trackingSince: string;
    accounts: Array<{ platform: string; handle: string }>;
    products: Array<{
      id: string;
      slug: string;
      name: string;
      url: string | null;
      description: string | null;
      kind: string | null;
      createdAt: string;
      sourceCount: number;
      releaseCount: number;
    }>;
    sources: Array<{
      id: string;
      slug: string;
      name: string;
      type: SourceType;
      url: string;
      fetchPriority: string | null;
      lastFetchedAt: string | null;
      lastPolledAt: string | null;
      medianGapDays: number | null;
      discovery: string;
      createdAt: string;
      kind: string | null;
      isPrimary: boolean | null;
      isHidden: boolean | null;
      changeDetectedAt: string | null;
      consecutiveNoChange: number | null;
      consecutiveErrors: number | null;
      nextFetchAfter: string | null;
      lastRetieredAt: string | null;
      metadata: string;
      stars: number | null;
      starsFetchedAt: string | null;
      releaseCount: number;
      latestVersion: string | null;
      latestDate: string | null;
      latestAddedAt: string | null;
      appStore: { platform: AppStorePlatform; iconUrl: string | null } | null;
      video: { provider: VideoProvider } | null;
      product: { slug: string; name: string } | null;
    }>;
  } | null;
};

export type OrgReleasesQueryVariables = Exact<{
  orgIdOrSlug: string;
  limit: number;
}>;

export type OrgReleasesQuery = {
  latestReleases: {
    nextCursor: string | null;
    items: Array<{
      id: string;
      title: string;
      version: string | null;
      type: ReleaseType;
      url: string | null;
      publishedAt: string | null;
      fetchedAt: string;
      summary: string | null;
      titleGenerated: string | null;
      titleShort: string | null;
      content: string;
      prerelease: boolean | null;
      breaking: string | null;
      media: Array<{ type: MediaKind; url: string; alt: string | null; r2Url: string | null }>;
      source: {
        slug: string;
        name: string;
        type: SourceType;
        appStore: { platform: AppStorePlatform; iconUrl: string | null } | null;
        video: { provider: VideoProvider } | null;
        product: { slug: string; name: string } | null;
      };
    }>;
  };
};

export type ProductPageQueryVariables = Exact<{
  id: string;
  releaseLimit: number;
}>;

export type ProductPageQuery = {
  product: {
    id: string;
    slug: string;
    name: string;
    url: string | null;
    description: string | null;
    category: string | null;
    tags: Array<string>;
    notice: {
      message: string;
      linkText: string | null;
      coordinate: string | null;
      href: string | null;
    } | null;
    sources: Array<{
      id: string;
      slug: string;
      name: string;
      type: SourceType;
      url: string;
      metadata: string;
      isHidden: boolean | null;
    }>;
    collections: Array<{
      slug: string;
      name: string;
      description: string | null;
      memberCount: number;
      isFeatured: boolean;
    }>;
  } | null;
  latestReleases: {
    nextCursor: string | null;
    items: Array<{
      id: string;
      title: string;
      version: string | null;
      type: ReleaseType;
      url: string | null;
      publishedAt: string | null;
      fetchedAt: string;
      summary: string | null;
      titleGenerated: string | null;
      titleShort: string | null;
      content: string;
      prerelease: boolean | null;
      breaking: string | null;
      media: Array<{ type: MediaKind; url: string; alt: string | null; r2Url: string | null }>;
      source: {
        slug: string;
        name: string;
        type: SourceType;
        appStore: { platform: AppStorePlatform; iconUrl: string | null } | null;
        video: { provider: VideoProvider } | null;
        product: { slug: string; name: string } | null;
      };
    }>;
  };
};

export type ReleaseDetailQueryVariables = Exact<{
  idOrUrl: string;
}>;

export type ReleaseDetailQuery = {
  release: {
    id: string;
    title: string;
    version: string | null;
    type: ReleaseType;
    url: string | null;
    publishedAt: string | null;
    fetchedAt: string;
    summary: string | null;
    titleGenerated: string | null;
    titleShort: string | null;
    content: string;
    migrationNotes: string | null;
    ogImageUrl: string | null;
    composition: { bugs: number; features: number; enhancements: number } | null;
    media: Array<{ type: MediaKind; url: string; alt: string | null; r2Url: string | null }>;
    source: {
      slug: string;
      name: string;
      type: SourceType;
      isHidden: boolean | null;
      org: {
        slug: string;
        name: string;
        avatarUrl: string | null;
        isHidden: boolean;
        discovery: OrgDiscovery;
      };
      product: { slug: string; name: string } | null;
      appStore: { platform: AppStorePlatform; iconUrl: string | null } | null;
      video: { provider: VideoProvider } | null;
    };
  } | null;
};

export type SourceDetailQueryVariables = Exact<{
  id: string;
  releaseLimit: number;
}>;

export type SourceDetailQuery = {
  source: {
    id: string;
    slug: string;
    name: string;
    type: SourceType;
    url: string;
    productId: string | null;
    isHidden: boolean | null;
    discovery: string;
    metadata: string;
    changelogUrl: string | null;
    hasChangelogFile: boolean;
    lastFetchedAt: string | null;
    lastPolledAt: string | null;
    trackingSince: string;
    latestVersion: string | null;
    latestDate: string | null;
    notice: {
      message: string;
      linkText: string | null;
      coordinate: string | null;
      href: string | null;
    } | null;
    summaries: {
      rolling: {
        year: number | null;
        month: number | null;
        windowDays: number | null;
        summary: string;
        releaseCount: number;
        generatedAt: string;
      } | null;
      monthly: Array<{
        year: number | null;
        month: number | null;
        windowDays: number | null;
        summary: string;
        releaseCount: number;
        generatedAt: string;
      }>;
    };
    org: { id: string; slug: string; name: string };
    releases: Array<{
      id: string;
      title: string;
      version: string | null;
      type: ReleaseType;
      url: string | null;
      publishedAt: string | null;
      fetchedAt: string;
      titleGenerated: string | null;
      titleShort: string | null;
      content: string;
      summary: string | null;
      media: Array<{ type: MediaKind; url: string; alt: string | null; r2Url: string | null }>;
    }>;
  } | null;
};

export const CollectionPageDocument = {
  __meta__: { hash: "sha256:a3acd59c42280cd431d118861711c775337bc4727f0965614f34d7ab141a0a85" },
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "CollectionPage" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "slug" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "String" } },
          },
        },
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "releaseLimit" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "Int" } },
          },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "collection" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "slug" },
                value: { kind: "Variable", name: { kind: "Name", value: "slug" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "slug" } },
                { kind: "Field", name: { kind: "Name", value: "name" } },
                { kind: "Field", name: { kind: "Name", value: "description" } },
                { kind: "Field", name: { kind: "Name", value: "isFeatured" } },
                { kind: "Field", name: { kind: "Name", value: "dailySummaryEnabled" } },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "members" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "__typename" } },
                      {
                        kind: "InlineFragment",
                        typeCondition: {
                          kind: "NamedType",
                          name: { kind: "Name", value: "CollectionMemberOrg" },
                        },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "slug" } },
                            { kind: "Field", name: { kind: "Name", value: "name" } },
                            { kind: "Field", name: { kind: "Name", value: "domain" } },
                            { kind: "Field", name: { kind: "Name", value: "avatarUrl" } },
                            { kind: "Field", name: { kind: "Name", value: "githubHandle" } },
                            { kind: "Field", name: { kind: "Name", value: "description" } },
                          ],
                        },
                      },
                      {
                        kind: "InlineFragment",
                        typeCondition: {
                          kind: "NamedType",
                          name: { kind: "Name", value: "CollectionMemberProduct" },
                        },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "slug" } },
                            { kind: "Field", name: { kind: "Name", value: "name" } },
                            { kind: "Field", name: { kind: "Name", value: "description" } },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "org" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "slug" } },
                                  { kind: "Field", name: { kind: "Name", value: "name" } },
                                  { kind: "Field", name: { kind: "Name", value: "domain" } },
                                  { kind: "Field", name: { kind: "Name", value: "avatarUrl" } },
                                  { kind: "Field", name: { kind: "Name", value: "githubHandle" } },
                                ],
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "releases" },
                  arguments: [
                    {
                      kind: "Argument",
                      name: { kind: "Name", value: "limit" },
                      value: { kind: "Variable", name: { kind: "Name", value: "releaseLimit" } },
                    },
                  ],
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "nextCursor" } },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "items" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "id" } },
                            { kind: "Field", name: { kind: "Name", value: "title" } },
                            { kind: "Field", name: { kind: "Name", value: "version" } },
                            { kind: "Field", name: { kind: "Name", value: "type" } },
                            { kind: "Field", name: { kind: "Name", value: "url" } },
                            { kind: "Field", name: { kind: "Name", value: "publishedAt" } },
                            { kind: "Field", name: { kind: "Name", value: "summary" } },
                            { kind: "Field", name: { kind: "Name", value: "content" } },
                            { kind: "Field", name: { kind: "Name", value: "titleGenerated" } },
                            { kind: "Field", name: { kind: "Name", value: "titleShort" } },
                            { kind: "Field", name: { kind: "Name", value: "prerelease" } },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "media" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "type" } },
                                  { kind: "Field", name: { kind: "Name", value: "url" } },
                                  { kind: "Field", name: { kind: "Name", value: "alt" } },
                                  { kind: "Field", name: { kind: "Name", value: "r2Url" } },
                                ],
                              },
                            },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "source" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "slug" } },
                                  { kind: "Field", name: { kind: "Name", value: "name" } },
                                  { kind: "Field", name: { kind: "Name", value: "type" } },
                                ],
                              },
                            },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "org" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "slug" } },
                                  { kind: "Field", name: { kind: "Name", value: "name" } },
                                ],
                              },
                            },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "product" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "slug" } },
                                  { kind: "Field", name: { kind: "Name", value: "name" } },
                                ],
                              },
                            },
                            { kind: "Field", name: { kind: "Name", value: "groupSlug" } },
                            { kind: "Field", name: { kind: "Name", value: "groupName" } },
                            { kind: "Field", name: { kind: "Name", value: "coverageCount" } },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "composition" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "bugs" } },
                                  { kind: "Field", name: { kind: "Name", value: "features" } },
                                  { kind: "Field", name: { kind: "Name", value: "enhancements" } },
                                ],
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "dailySummaries" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "date" } },
                      { kind: "Field", name: { kind: "Name", value: "title" } },
                      { kind: "Field", name: { kind: "Name", value: "summary" } },
                      { kind: "Field", name: { kind: "Name", value: "takeaways" } },
                      { kind: "Field", name: { kind: "Name", value: "releaseCount" } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<CollectionPageQuery, CollectionPageQueryVariables>;
export const HomepageAllOrgsDocument = {
  __meta__: { hash: "sha256:b5f9fa07fd60f90839b1f976d116320290ce322946963b2d376139a8c7371b7e" },
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "HomepageAllOrgs" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "limit" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "Int" } },
          },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "orgs" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "includeEmpty" },
                value: { kind: "BooleanValue", value: false },
              },
              {
                kind: "Argument",
                name: { kind: "Name", value: "limit" },
                value: { kind: "Variable", name: { kind: "Name", value: "limit" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                {
                  kind: "Field",
                  name: { kind: "Name", value: "items" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "slug" } },
                      { kind: "Field", name: { kind: "Name", value: "name" } },
                      { kind: "Field", name: { kind: "Name", value: "domain" } },
                      { kind: "Field", name: { kind: "Name", value: "avatarUrl" } },
                      { kind: "Field", name: { kind: "Name", value: "sourceCount" } },
                      { kind: "Field", name: { kind: "Name", value: "releaseCount" } },
                      { kind: "Field", name: { kind: "Name", value: "recentReleaseCount" } },
                      { kind: "Field", name: { kind: "Name", value: "lastActivity" } },
                      { kind: "Field", name: { kind: "Name", value: "topProducts" } },
                      { kind: "Field", name: { kind: "Name", value: "sparkline" } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<HomepageAllOrgsQuery, HomepageAllOrgsQueryVariables>;
export const HomepageCollectionsDocument = {
  __meta__: { hash: "sha256:eb30575702a89df06aadfc4035de798b950dadc12db002342012ab9ebe1ae3fb" },
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "HomepageCollections" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "featured" } },
          type: { kind: "NamedType", name: { kind: "Name", value: "Boolean" } },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "collections" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "featured" },
                value: { kind: "Variable", name: { kind: "Name", value: "featured" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "slug" } },
                { kind: "Field", name: { kind: "Name", value: "name" } },
                { kind: "Field", name: { kind: "Name", value: "description" } },
                { kind: "Field", name: { kind: "Name", value: "memberCount" } },
                { kind: "Field", name: { kind: "Name", value: "isFeatured" } },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "previewMembers" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "__typename" } },
                      {
                        kind: "InlineFragment",
                        typeCondition: {
                          kind: "NamedType",
                          name: { kind: "Name", value: "CollectionMemberOrg" },
                        },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "slug" } },
                            { kind: "Field", name: { kind: "Name", value: "name" } },
                            { kind: "Field", name: { kind: "Name", value: "avatarUrl" } },
                            { kind: "Field", name: { kind: "Name", value: "githubHandle" } },
                          ],
                        },
                      },
                      {
                        kind: "InlineFragment",
                        typeCondition: {
                          kind: "NamedType",
                          name: { kind: "Name", value: "CollectionMemberProduct" },
                        },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "slug" } },
                            { kind: "Field", name: { kind: "Name", value: "name" } },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "org" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "slug" } },
                                  { kind: "Field", name: { kind: "Name", value: "name" } },
                                  { kind: "Field", name: { kind: "Name", value: "avatarUrl" } },
                                  { kind: "Field", name: { kind: "Name", value: "githubHandle" } },
                                ],
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<HomepageCollectionsQuery, HomepageCollectionsQueryVariables>;
export const HomepageOrgsStatsDocument = {
  __meta__: { hash: "sha256:46fa99b87fe2392f5f59b0508a47fa516b4f994537ea5d8906f11e6da18a71fd" },
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "HomepageOrgsStats" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "featuredLimit" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "Int" } },
          },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "stats" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "orgs" } },
                { kind: "Field", name: { kind: "Name", value: "sources" } },
                { kind: "Field", name: { kind: "Name", value: "releases" } },
              ],
            },
          },
          {
            kind: "Field",
            alias: { kind: "Name", value: "featuredOrgs" },
            name: { kind: "Name", value: "orgs" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "featured" },
                value: { kind: "BooleanValue", value: true },
              },
              {
                kind: "Argument",
                name: { kind: "Name", value: "limit" },
                value: { kind: "Variable", name: { kind: "Name", value: "featuredLimit" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                {
                  kind: "Field",
                  name: { kind: "Name", value: "items" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "slug" } },
                      { kind: "Field", name: { kind: "Name", value: "name" } },
                      { kind: "Field", name: { kind: "Name", value: "domain" } },
                      { kind: "Field", name: { kind: "Name", value: "avatarUrl" } },
                      { kind: "Field", name: { kind: "Name", value: "sourceCount" } },
                      { kind: "Field", name: { kind: "Name", value: "releaseCount" } },
                      { kind: "Field", name: { kind: "Name", value: "recentReleaseCount" } },
                      { kind: "Field", name: { kind: "Name", value: "lastActivity" } },
                      { kind: "Field", name: { kind: "Name", value: "topProducts" } },
                      { kind: "Field", name: { kind: "Name", value: "sparkline" } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<HomepageOrgsStatsQuery, HomepageOrgsStatsQueryVariables>;
export const HomepageTickerDocument = {
  __meta__: { hash: "sha256:e8b5f160ba9f17858d2da995ab6c3032dae4c2628100e0c8783b8565d40bf556" },
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "HomepageTicker" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "limit" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "Int" } },
          },
        },
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "exclude" } },
          type: {
            kind: "NonNullType",
            type: {
              kind: "ListType",
              type: {
                kind: "NonNullType",
                type: { kind: "NamedType", name: { kind: "Name", value: "SourceType" } },
              },
            },
          },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "latestReleases" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "limit" },
                value: { kind: "Variable", name: { kind: "Name", value: "limit" } },
              },
              {
                kind: "Argument",
                name: { kind: "Name", value: "excludeSourceTypes" },
                value: { kind: "Variable", name: { kind: "Name", value: "exclude" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                {
                  kind: "Field",
                  name: { kind: "Name", value: "items" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "id" } },
                      { kind: "Field", name: { kind: "Name", value: "title" } },
                      { kind: "Field", name: { kind: "Name", value: "version" } },
                      { kind: "Field", name: { kind: "Name", value: "publishedAt" } },
                      { kind: "Field", name: { kind: "Name", value: "titleGenerated" } },
                      { kind: "Field", name: { kind: "Name", value: "titleShort" } },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "media" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "type" } },
                            { kind: "Field", name: { kind: "Name", value: "url" } },
                            { kind: "Field", name: { kind: "Name", value: "alt" } },
                            { kind: "Field", name: { kind: "Name", value: "r2Url" } },
                          ],
                        },
                      },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "source" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "org" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "slug" } },
                                  { kind: "Field", name: { kind: "Name", value: "name" } },
                                  { kind: "Field", name: { kind: "Name", value: "avatarUrl" } },
                                ],
                              },
                            },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "product" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "slug" } },
                                  { kind: "Field", name: { kind: "Name", value: "name" } },
                                ],
                              },
                            },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "appStore" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "platform" } },
                                  { kind: "Field", name: { kind: "Name", value: "iconUrl" } },
                                ],
                              },
                            },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "video" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "provider" } },
                                ],
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<HomepageTickerQuery, HomepageTickerQueryVariables>;
export const OrgCollectionsDocument = {
  __meta__: { hash: "sha256:2f85eba030a7a519bf72cab12801afad38797aa9e9d772d1976f6fd348cae432" },
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "OrgCollections" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "idOrSlug" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "String" } },
          },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "org" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "idOrSlug" },
                value: { kind: "Variable", name: { kind: "Name", value: "idOrSlug" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                {
                  kind: "Field",
                  name: { kind: "Name", value: "collections" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "slug" } },
                      { kind: "Field", name: { kind: "Name", value: "name" } },
                      { kind: "Field", name: { kind: "Name", value: "description" } },
                      { kind: "Field", name: { kind: "Name", value: "memberCount" } },
                      { kind: "Field", name: { kind: "Name", value: "isFeatured" } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<OrgCollectionsQuery, OrgCollectionsQueryVariables>;
export const OrgPageDocument = {
  __meta__: { hash: "sha256:0a7f1743532d73eb26d165eeac9401c8e606798955c58d2a5ab60066977f8f9a" },
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "OrgPage" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "idOrSlug" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "String" } },
          },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "org" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "idOrSlug" },
                value: { kind: "Variable", name: { kind: "Name", value: "idOrSlug" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "id" } },
                { kind: "Field", name: { kind: "Name", value: "slug" } },
                { kind: "Field", name: { kind: "Name", value: "name" } },
                { kind: "Field", name: { kind: "Name", value: "domain" } },
                { kind: "Field", name: { kind: "Name", value: "description" } },
                { kind: "Field", name: { kind: "Name", value: "category" } },
                { kind: "Field", name: { kind: "Name", value: "avatarUrl" } },
                { kind: "Field", name: { kind: "Name", value: "isHidden" } },
                { kind: "Field", name: { kind: "Name", value: "autoGenerateContent" } },
                { kind: "Field", name: { kind: "Name", value: "overviewCadenceDays" } },
                { kind: "Field", name: { kind: "Name", value: "featured" } },
                { kind: "Field", name: { kind: "Name", value: "fetchPaused" } },
                { kind: "Field", name: { kind: "Name", value: "discovery" } },
                { kind: "Field", name: { kind: "Name", value: "status" } },
                { kind: "Field", name: { kind: "Name", value: "locations" } },
                { kind: "Field", name: { kind: "Name", value: "tags" } },
                { kind: "Field", name: { kind: "Name", value: "aliases" } },
                { kind: "Field", name: { kind: "Name", value: "notice" } },
                { kind: "Field", name: { kind: "Name", value: "sourceCount" } },
                { kind: "Field", name: { kind: "Name", value: "releaseCount" } },
                { kind: "Field", name: { kind: "Name", value: "releasesLast30Days" } },
                { kind: "Field", name: { kind: "Name", value: "avgReleasesPerWeek" } },
                { kind: "Field", name: { kind: "Name", value: "lastFetchedAt" } },
                { kind: "Field", name: { kind: "Name", value: "lastPolledAt" } },
                { kind: "Field", name: { kind: "Name", value: "trackingSince" } },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "accounts" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "platform" } },
                      { kind: "Field", name: { kind: "Name", value: "handle" } },
                    ],
                  },
                },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "products" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "id" } },
                      { kind: "Field", name: { kind: "Name", value: "slug" } },
                      { kind: "Field", name: { kind: "Name", value: "name" } },
                      { kind: "Field", name: { kind: "Name", value: "url" } },
                      { kind: "Field", name: { kind: "Name", value: "description" } },
                      { kind: "Field", name: { kind: "Name", value: "kind" } },
                      { kind: "Field", name: { kind: "Name", value: "createdAt" } },
                      { kind: "Field", name: { kind: "Name", value: "sourceCount" } },
                      { kind: "Field", name: { kind: "Name", value: "releaseCount" } },
                    ],
                  },
                },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "sources" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "id" } },
                      { kind: "Field", name: { kind: "Name", value: "slug" } },
                      { kind: "Field", name: { kind: "Name", value: "name" } },
                      { kind: "Field", name: { kind: "Name", value: "type" } },
                      { kind: "Field", name: { kind: "Name", value: "url" } },
                      { kind: "Field", name: { kind: "Name", value: "fetchPriority" } },
                      { kind: "Field", name: { kind: "Name", value: "lastFetchedAt" } },
                      { kind: "Field", name: { kind: "Name", value: "lastPolledAt" } },
                      { kind: "Field", name: { kind: "Name", value: "medianGapDays" } },
                      { kind: "Field", name: { kind: "Name", value: "discovery" } },
                      { kind: "Field", name: { kind: "Name", value: "createdAt" } },
                      { kind: "Field", name: { kind: "Name", value: "kind" } },
                      { kind: "Field", name: { kind: "Name", value: "isPrimary" } },
                      { kind: "Field", name: { kind: "Name", value: "isHidden" } },
                      { kind: "Field", name: { kind: "Name", value: "changeDetectedAt" } },
                      { kind: "Field", name: { kind: "Name", value: "consecutiveNoChange" } },
                      { kind: "Field", name: { kind: "Name", value: "consecutiveErrors" } },
                      { kind: "Field", name: { kind: "Name", value: "nextFetchAfter" } },
                      { kind: "Field", name: { kind: "Name", value: "lastRetieredAt" } },
                      { kind: "Field", name: { kind: "Name", value: "metadata" } },
                      { kind: "Field", name: { kind: "Name", value: "stars" } },
                      { kind: "Field", name: { kind: "Name", value: "starsFetchedAt" } },
                      { kind: "Field", name: { kind: "Name", value: "releaseCount" } },
                      { kind: "Field", name: { kind: "Name", value: "latestVersion" } },
                      { kind: "Field", name: { kind: "Name", value: "latestDate" } },
                      { kind: "Field", name: { kind: "Name", value: "latestAddedAt" } },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "appStore" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "platform" } },
                            { kind: "Field", name: { kind: "Name", value: "iconUrl" } },
                          ],
                        },
                      },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "video" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "provider" } },
                          ],
                        },
                      },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "product" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "slug" } },
                            { kind: "Field", name: { kind: "Name", value: "name" } },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<OrgPageQuery, OrgPageQueryVariables>;
export const OrgReleasesDocument = {
  __meta__: { hash: "sha256:04d43cffb2dc13964cd3ebc5a6c7acdf53ab7f2b8282121141b6cbffe4e86d70" },
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "OrgReleases" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "orgIdOrSlug" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "String" } },
          },
        },
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "limit" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "Int" } },
          },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "latestReleases" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "orgIdOrSlug" },
                value: { kind: "Variable", name: { kind: "Name", value: "orgIdOrSlug" } },
              },
              {
                kind: "Argument",
                name: { kind: "Name", value: "limit" },
                value: { kind: "Variable", name: { kind: "Name", value: "limit" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "nextCursor" } },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "items" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "id" } },
                      { kind: "Field", name: { kind: "Name", value: "title" } },
                      { kind: "Field", name: { kind: "Name", value: "version" } },
                      { kind: "Field", name: { kind: "Name", value: "type" } },
                      { kind: "Field", name: { kind: "Name", value: "url" } },
                      { kind: "Field", name: { kind: "Name", value: "publishedAt" } },
                      { kind: "Field", name: { kind: "Name", value: "fetchedAt" } },
                      { kind: "Field", name: { kind: "Name", value: "summary" } },
                      { kind: "Field", name: { kind: "Name", value: "titleGenerated" } },
                      { kind: "Field", name: { kind: "Name", value: "titleShort" } },
                      { kind: "Field", name: { kind: "Name", value: "content" } },
                      { kind: "Field", name: { kind: "Name", value: "prerelease" } },
                      { kind: "Field", name: { kind: "Name", value: "breaking" } },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "media" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "type" } },
                            { kind: "Field", name: { kind: "Name", value: "url" } },
                            { kind: "Field", name: { kind: "Name", value: "alt" } },
                            { kind: "Field", name: { kind: "Name", value: "r2Url" } },
                          ],
                        },
                      },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "source" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "slug" } },
                            { kind: "Field", name: { kind: "Name", value: "name" } },
                            { kind: "Field", name: { kind: "Name", value: "type" } },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "appStore" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "platform" } },
                                  { kind: "Field", name: { kind: "Name", value: "iconUrl" } },
                                ],
                              },
                            },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "video" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "provider" } },
                                ],
                              },
                            },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "product" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "slug" } },
                                  { kind: "Field", name: { kind: "Name", value: "name" } },
                                ],
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<OrgReleasesQuery, OrgReleasesQueryVariables>;
export const ProductPageDocument = {
  __meta__: { hash: "sha256:8bbe4adb3c5316c7a9bf8b4daf1d8635993d0d1bab26d3fdfaa334d5107b2f82" },
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "ProductPage" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "id" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "String" } },
          },
        },
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "releaseLimit" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "Int" } },
          },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "product" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "id" },
                value: { kind: "Variable", name: { kind: "Name", value: "id" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "id" } },
                { kind: "Field", name: { kind: "Name", value: "slug" } },
                { kind: "Field", name: { kind: "Name", value: "name" } },
                { kind: "Field", name: { kind: "Name", value: "url" } },
                { kind: "Field", name: { kind: "Name", value: "description" } },
                { kind: "Field", name: { kind: "Name", value: "category" } },
                { kind: "Field", name: { kind: "Name", value: "tags" } },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "notice" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "message" } },
                      { kind: "Field", name: { kind: "Name", value: "linkText" } },
                      { kind: "Field", name: { kind: "Name", value: "coordinate" } },
                      { kind: "Field", name: { kind: "Name", value: "href" } },
                    ],
                  },
                },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "sources" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "id" } },
                      { kind: "Field", name: { kind: "Name", value: "slug" } },
                      { kind: "Field", name: { kind: "Name", value: "name" } },
                      { kind: "Field", name: { kind: "Name", value: "type" } },
                      { kind: "Field", name: { kind: "Name", value: "url" } },
                      { kind: "Field", name: { kind: "Name", value: "metadata" } },
                      { kind: "Field", name: { kind: "Name", value: "isHidden" } },
                    ],
                  },
                },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "collections" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "slug" } },
                      { kind: "Field", name: { kind: "Name", value: "name" } },
                      { kind: "Field", name: { kind: "Name", value: "description" } },
                      { kind: "Field", name: { kind: "Name", value: "memberCount" } },
                      { kind: "Field", name: { kind: "Name", value: "isFeatured" } },
                    ],
                  },
                },
              ],
            },
          },
          {
            kind: "Field",
            name: { kind: "Name", value: "latestReleases" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "productId" },
                value: { kind: "Variable", name: { kind: "Name", value: "id" } },
              },
              {
                kind: "Argument",
                name: { kind: "Name", value: "limit" },
                value: { kind: "Variable", name: { kind: "Name", value: "releaseLimit" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "nextCursor" } },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "items" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "id" } },
                      { kind: "Field", name: { kind: "Name", value: "title" } },
                      { kind: "Field", name: { kind: "Name", value: "version" } },
                      { kind: "Field", name: { kind: "Name", value: "type" } },
                      { kind: "Field", name: { kind: "Name", value: "url" } },
                      { kind: "Field", name: { kind: "Name", value: "publishedAt" } },
                      { kind: "Field", name: { kind: "Name", value: "fetchedAt" } },
                      { kind: "Field", name: { kind: "Name", value: "summary" } },
                      { kind: "Field", name: { kind: "Name", value: "titleGenerated" } },
                      { kind: "Field", name: { kind: "Name", value: "titleShort" } },
                      { kind: "Field", name: { kind: "Name", value: "content" } },
                      { kind: "Field", name: { kind: "Name", value: "prerelease" } },
                      { kind: "Field", name: { kind: "Name", value: "breaking" } },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "media" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "type" } },
                            { kind: "Field", name: { kind: "Name", value: "url" } },
                            { kind: "Field", name: { kind: "Name", value: "alt" } },
                            { kind: "Field", name: { kind: "Name", value: "r2Url" } },
                          ],
                        },
                      },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "source" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "slug" } },
                            { kind: "Field", name: { kind: "Name", value: "name" } },
                            { kind: "Field", name: { kind: "Name", value: "type" } },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "appStore" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "platform" } },
                                  { kind: "Field", name: { kind: "Name", value: "iconUrl" } },
                                ],
                              },
                            },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "video" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "provider" } },
                                ],
                              },
                            },
                            {
                              kind: "Field",
                              name: { kind: "Name", value: "product" },
                              selectionSet: {
                                kind: "SelectionSet",
                                selections: [
                                  { kind: "Field", name: { kind: "Name", value: "slug" } },
                                  { kind: "Field", name: { kind: "Name", value: "name" } },
                                ],
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<ProductPageQuery, ProductPageQueryVariables>;
export const ReleaseDetailDocument = {
  __meta__: { hash: "sha256:dc00d207481809d195bba3bd3a39caa77cf0a3dc065e24fa7c4e9d5cab6bcb8e" },
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "ReleaseDetail" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "idOrUrl" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "String" } },
          },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "release" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "idOrUrl" },
                value: { kind: "Variable", name: { kind: "Name", value: "idOrUrl" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "id" } },
                { kind: "Field", name: { kind: "Name", value: "title" } },
                { kind: "Field", name: { kind: "Name", value: "version" } },
                { kind: "Field", name: { kind: "Name", value: "type" } },
                { kind: "Field", name: { kind: "Name", value: "url" } },
                { kind: "Field", name: { kind: "Name", value: "publishedAt" } },
                { kind: "Field", name: { kind: "Name", value: "fetchedAt" } },
                { kind: "Field", name: { kind: "Name", value: "summary" } },
                { kind: "Field", name: { kind: "Name", value: "titleGenerated" } },
                { kind: "Field", name: { kind: "Name", value: "titleShort" } },
                { kind: "Field", name: { kind: "Name", value: "content" } },
                { kind: "Field", name: { kind: "Name", value: "migrationNotes" } },
                { kind: "Field", name: { kind: "Name", value: "ogImageUrl" } },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "composition" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "bugs" } },
                      { kind: "Field", name: { kind: "Name", value: "features" } },
                      { kind: "Field", name: { kind: "Name", value: "enhancements" } },
                    ],
                  },
                },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "media" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "type" } },
                      { kind: "Field", name: { kind: "Name", value: "url" } },
                      { kind: "Field", name: { kind: "Name", value: "alt" } },
                      { kind: "Field", name: { kind: "Name", value: "r2Url" } },
                    ],
                  },
                },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "source" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "slug" } },
                      { kind: "Field", name: { kind: "Name", value: "name" } },
                      { kind: "Field", name: { kind: "Name", value: "type" } },
                      { kind: "Field", name: { kind: "Name", value: "isHidden" } },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "org" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "slug" } },
                            { kind: "Field", name: { kind: "Name", value: "name" } },
                            { kind: "Field", name: { kind: "Name", value: "avatarUrl" } },
                            { kind: "Field", name: { kind: "Name", value: "isHidden" } },
                            { kind: "Field", name: { kind: "Name", value: "discovery" } },
                          ],
                        },
                      },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "product" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "slug" } },
                            { kind: "Field", name: { kind: "Name", value: "name" } },
                          ],
                        },
                      },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "appStore" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "platform" } },
                            { kind: "Field", name: { kind: "Name", value: "iconUrl" } },
                          ],
                        },
                      },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "video" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "provider" } },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<ReleaseDetailQuery, ReleaseDetailQueryVariables>;
export const SourceDetailDocument = {
  __meta__: { hash: "sha256:a9b727e50ab142ce7aa42763f0faa91f1b26aa4b7a9e974064c19d4f164a4b84" },
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "SourceDetail" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "id" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "String" } },
          },
        },
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "releaseLimit" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "Int" } },
          },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "source" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "id" },
                value: { kind: "Variable", name: { kind: "Name", value: "id" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "id" } },
                { kind: "Field", name: { kind: "Name", value: "slug" } },
                { kind: "Field", name: { kind: "Name", value: "name" } },
                { kind: "Field", name: { kind: "Name", value: "type" } },
                { kind: "Field", name: { kind: "Name", value: "url" } },
                { kind: "Field", name: { kind: "Name", value: "productId" } },
                { kind: "Field", name: { kind: "Name", value: "isHidden" } },
                { kind: "Field", name: { kind: "Name", value: "discovery" } },
                { kind: "Field", name: { kind: "Name", value: "metadata" } },
                { kind: "Field", name: { kind: "Name", value: "changelogUrl" } },
                { kind: "Field", name: { kind: "Name", value: "hasChangelogFile" } },
                { kind: "Field", name: { kind: "Name", value: "lastFetchedAt" } },
                { kind: "Field", name: { kind: "Name", value: "lastPolledAt" } },
                { kind: "Field", name: { kind: "Name", value: "trackingSince" } },
                { kind: "Field", name: { kind: "Name", value: "latestVersion" } },
                { kind: "Field", name: { kind: "Name", value: "latestDate" } },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "notice" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "message" } },
                      { kind: "Field", name: { kind: "Name", value: "linkText" } },
                      { kind: "Field", name: { kind: "Name", value: "coordinate" } },
                      { kind: "Field", name: { kind: "Name", value: "href" } },
                    ],
                  },
                },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "summaries" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "rolling" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "year" } },
                            { kind: "Field", name: { kind: "Name", value: "month" } },
                            { kind: "Field", name: { kind: "Name", value: "windowDays" } },
                            { kind: "Field", name: { kind: "Name", value: "summary" } },
                            { kind: "Field", name: { kind: "Name", value: "releaseCount" } },
                            { kind: "Field", name: { kind: "Name", value: "generatedAt" } },
                          ],
                        },
                      },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "monthly" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "year" } },
                            { kind: "Field", name: { kind: "Name", value: "month" } },
                            { kind: "Field", name: { kind: "Name", value: "windowDays" } },
                            { kind: "Field", name: { kind: "Name", value: "summary" } },
                            { kind: "Field", name: { kind: "Name", value: "releaseCount" } },
                            { kind: "Field", name: { kind: "Name", value: "generatedAt" } },
                          ],
                        },
                      },
                    ],
                  },
                },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "org" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "id" } },
                      { kind: "Field", name: { kind: "Name", value: "slug" } },
                      { kind: "Field", name: { kind: "Name", value: "name" } },
                    ],
                  },
                },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "releases" },
                  arguments: [
                    {
                      kind: "Argument",
                      name: { kind: "Name", value: "limit" },
                      value: { kind: "Variable", name: { kind: "Name", value: "releaseLimit" } },
                    },
                  ],
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "id" } },
                      { kind: "Field", name: { kind: "Name", value: "title" } },
                      { kind: "Field", name: { kind: "Name", value: "version" } },
                      { kind: "Field", name: { kind: "Name", value: "type" } },
                      { kind: "Field", name: { kind: "Name", value: "url" } },
                      { kind: "Field", name: { kind: "Name", value: "publishedAt" } },
                      { kind: "Field", name: { kind: "Name", value: "fetchedAt" } },
                      { kind: "Field", name: { kind: "Name", value: "titleGenerated" } },
                      { kind: "Field", name: { kind: "Name", value: "titleShort" } },
                      { kind: "Field", name: { kind: "Name", value: "content" } },
                      { kind: "Field", name: { kind: "Name", value: "summary" } },
                      {
                        kind: "Field",
                        name: { kind: "Name", value: "media" },
                        selectionSet: {
                          kind: "SelectionSet",
                          selections: [
                            { kind: "Field", name: { kind: "Name", value: "type" } },
                            { kind: "Field", name: { kind: "Name", value: "url" } },
                            { kind: "Field", name: { kind: "Name", value: "alt" } },
                            { kind: "Field", name: { kind: "Name", value: "r2Url" } },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SourceDetailQuery, SourceDetailQueryVariables>;
