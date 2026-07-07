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

/** Whether a release is a normal feature/changelog entry or a seasonal/quarterly rollup catch-all. */
export type ReleaseType = "feature" | "rollup";

/** How a source is ingested: GitHub releases API, scraped HTML, parsed feed, or AI agent. */
export type SourceType = "agent" | "appstore" | "feed" | "github" | "scrape" | "video";

/** Provider for a video source. */
export type VideoProvider = "vimeo" | "wistia" | "youtube";

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
      source: {
        org: { slug: string; name: string; avatarUrl: string | null };
        product: { slug: string; name: string } | null;
        appStore: { platform: AppStorePlatform; iconUrl: string | null } | null;
        video: { provider: VideoProvider } | null;
      };
    }>;
  };
};

export type ProductDetailQueryVariables = Exact<{
  id: string;
}>;

export type ProductDetailQuery = {
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
      isHidden: boolean;
    }>;
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
    isHidden: boolean;
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

export const HomepageTickerDocument = {
  __meta__: { hash: "sha256:eb15101c1fc45e4d3bc46bceb18b929e840f636c694ac36b498e32280e9873cc" },
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
export const ProductDetailDocument = {
  __meta__: { hash: "sha256:6791f51cdafe4def724d68b5a61f881624ca607ffab50baf2bf7fac5427929b5" },
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "ProductDetail" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "id" } },
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
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<ProductDetailQuery, ProductDetailQueryVariables>;
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
