/* eslint-disable */
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> =
  | T
  | { [P in keyof T]?: P extends " $fragmentName" | "__typename" ? T[P] : never };
import { TypedDocumentNode as DocumentNode } from "@graphql-typed-document-node/core";
/** Kind of media attached to a release. */
export type MediaKind = "gif" | "image" | "video";

/** Whether a release is a normal feature/changelog entry or a seasonal/quarterly rollup catch-all. */
export type ReleaseType = "feature" | "rollup";

/** How a source is ingested: GitHub releases API, scraped HTML, parsed feed, or AI agent. */
export type SourceType = "agent" | "feed" | "github" | "scrape";

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
      type: ReleaseType;
      url: string | null;
      publishedAt: string | null;
      summary: string | null;
      titleGenerated: string | null;
      titleShort: string | null;
      media: Array<{ type: MediaKind; url: string; alt: string | null; r2Url: string | null }>;
      source: { slug: string; name: string; type: SourceType; org: { slug: string; name: string } };
    }>;
  };
};

export const HomepageTickerDocument = {
  __meta__: { hash: "sha256:25eedd0241ec74a3becd144b9a09d831e3fb4fa70316d8bb13e5431756651382" },
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
                      { kind: "Field", name: { kind: "Name", value: "type" } },
                      { kind: "Field", name: { kind: "Name", value: "url" } },
                      { kind: "Field", name: { kind: "Name", value: "publishedAt" } },
                      { kind: "Field", name: { kind: "Name", value: "summary" } },
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
                            { kind: "Field", name: { kind: "Name", value: "slug" } },
                            { kind: "Field", name: { kind: "Name", value: "name" } },
                            { kind: "Field", name: { kind: "Name", value: "type" } },
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
