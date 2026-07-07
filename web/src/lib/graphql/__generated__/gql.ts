/* eslint-disable */
import * as types from "./graphql";
import { TypedDocumentNode as DocumentNode } from "@graphql-typed-document-node/core";

/**
 * Map of all GraphQL operations in the project.
 *
 * This map has several performance disadvantages:
 * 1. It is not tree-shakeable, so it will include all operations in the project.
 * 2. It is not minifiable, so the string of a GraphQL query will be multiple times inside the bundle.
 * 3. It does not support dead code elimination, so it will add unused operations.
 *
 * Therefore it is highly recommended to use the babel or swc plugin for production.
 * Learn more about it here: https://the-guild.dev/graphql/codegen/plugins/presets/preset-client#reducing-bundle-size
 */
type Documents = {
  "query HomepageTicker($limit: Int!, $exclude: [SourceType!]!) {\n  latestReleases(limit: $limit, excludeSourceTypes: $exclude) {\n    items {\n      id\n      title\n      version\n      publishedAt\n      titleGenerated\n      titleShort\n      source {\n        org {\n          slug\n          name\n          avatarUrl\n        }\n        product {\n          slug\n          name\n        }\n        appStore {\n          platform\n          iconUrl\n        }\n        video {\n          provider\n        }\n      }\n    }\n  }\n}": typeof types.HomepageTickerDocument;
  "query ProductDetail($id: String!) {\n  product(id: $id) {\n    id\n    slug\n    name\n    url\n    description\n    category\n    tags\n    notice {\n      message\n      linkText\n      coordinate\n      href\n    }\n    sources {\n      id\n      slug\n      name\n      type\n      url\n      metadata\n      isHidden\n    }\n  }\n}": typeof types.ProductDetailDocument;
  "query SourceDetail($id: String!, $releaseLimit: Int!) {\n  source(id: $id) {\n    id\n    slug\n    name\n    type\n    url\n    productId\n    isHidden\n    discovery\n    metadata\n    changelogUrl\n    hasChangelogFile\n    lastFetchedAt\n    lastPolledAt\n    trackingSince\n    latestVersion\n    latestDate\n    notice {\n      message\n      linkText\n      coordinate\n      href\n    }\n    summaries {\n      rolling {\n        year\n        month\n        windowDays\n        summary\n        releaseCount\n        generatedAt\n      }\n      monthly {\n        year\n        month\n        windowDays\n        summary\n        releaseCount\n        generatedAt\n      }\n    }\n    org {\n      id\n      slug\n      name\n    }\n    releases(limit: $releaseLimit) {\n      id\n      title\n      version\n      type\n      url\n      publishedAt\n      fetchedAt\n      titleGenerated\n      titleShort\n      content\n      summary\n      media {\n        type\n        url\n        alt\n        r2Url\n      }\n    }\n  }\n}": typeof types.SourceDetailDocument;
};
const documents: Documents = {
  "query HomepageTicker($limit: Int!, $exclude: [SourceType!]!) {\n  latestReleases(limit: $limit, excludeSourceTypes: $exclude) {\n    items {\n      id\n      title\n      version\n      publishedAt\n      titleGenerated\n      titleShort\n      source {\n        org {\n          slug\n          name\n          avatarUrl\n        }\n        product {\n          slug\n          name\n        }\n        appStore {\n          platform\n          iconUrl\n        }\n        video {\n          provider\n        }\n      }\n    }\n  }\n}":
    types.HomepageTickerDocument,
  "query ProductDetail($id: String!) {\n  product(id: $id) {\n    id\n    slug\n    name\n    url\n    description\n    category\n    tags\n    notice {\n      message\n      linkText\n      coordinate\n      href\n    }\n    sources {\n      id\n      slug\n      name\n      type\n      url\n      metadata\n      isHidden\n    }\n  }\n}":
    types.ProductDetailDocument,
  "query SourceDetail($id: String!, $releaseLimit: Int!) {\n  source(id: $id) {\n    id\n    slug\n    name\n    type\n    url\n    productId\n    isHidden\n    discovery\n    metadata\n    changelogUrl\n    hasChangelogFile\n    lastFetchedAt\n    lastPolledAt\n    trackingSince\n    latestVersion\n    latestDate\n    notice {\n      message\n      linkText\n      coordinate\n      href\n    }\n    summaries {\n      rolling {\n        year\n        month\n        windowDays\n        summary\n        releaseCount\n        generatedAt\n      }\n      monthly {\n        year\n        month\n        windowDays\n        summary\n        releaseCount\n        generatedAt\n      }\n    }\n    org {\n      id\n      slug\n      name\n    }\n    releases(limit: $releaseLimit) {\n      id\n      title\n      version\n      type\n      url\n      publishedAt\n      fetchedAt\n      titleGenerated\n      titleShort\n      content\n      summary\n      media {\n        type\n        url\n        alt\n        r2Url\n      }\n    }\n  }\n}":
    types.SourceDetailDocument,
};

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 *
 *
 * @example
 * ```ts
 * const query = graphql(`query GetUser($id: ID!) { user(id: $id) { name } }`);
 * ```
 *
 * The query argument is unknown!
 * Please regenerate the types.
 */
export function graphql(source: string): unknown;

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: "query HomepageTicker($limit: Int!, $exclude: [SourceType!]!) {\n  latestReleases(limit: $limit, excludeSourceTypes: $exclude) {\n    items {\n      id\n      title\n      version\n      publishedAt\n      titleGenerated\n      titleShort\n      source {\n        org {\n          slug\n          name\n          avatarUrl\n        }\n        product {\n          slug\n          name\n        }\n        appStore {\n          platform\n          iconUrl\n        }\n        video {\n          provider\n        }\n      }\n    }\n  }\n}",
): (typeof documents)["query HomepageTicker($limit: Int!, $exclude: [SourceType!]!) {\n  latestReleases(limit: $limit, excludeSourceTypes: $exclude) {\n    items {\n      id\n      title\n      version\n      publishedAt\n      titleGenerated\n      titleShort\n      source {\n        org {\n          slug\n          name\n          avatarUrl\n        }\n        product {\n          slug\n          name\n        }\n        appStore {\n          platform\n          iconUrl\n        }\n        video {\n          provider\n        }\n      }\n    }\n  }\n}"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: "query ProductDetail($id: String!) {\n  product(id: $id) {\n    id\n    slug\n    name\n    url\n    description\n    category\n    tags\n    notice {\n      message\n      linkText\n      coordinate\n      href\n    }\n    sources {\n      id\n      slug\n      name\n      type\n      url\n      metadata\n      isHidden\n    }\n  }\n}",
): (typeof documents)["query ProductDetail($id: String!) {\n  product(id: $id) {\n    id\n    slug\n    name\n    url\n    description\n    category\n    tags\n    notice {\n      message\n      linkText\n      coordinate\n      href\n    }\n    sources {\n      id\n      slug\n      name\n      type\n      url\n      metadata\n      isHidden\n    }\n  }\n}"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: "query SourceDetail($id: String!, $releaseLimit: Int!) {\n  source(id: $id) {\n    id\n    slug\n    name\n    type\n    url\n    productId\n    isHidden\n    discovery\n    metadata\n    changelogUrl\n    hasChangelogFile\n    lastFetchedAt\n    lastPolledAt\n    trackingSince\n    latestVersion\n    latestDate\n    notice {\n      message\n      linkText\n      coordinate\n      href\n    }\n    summaries {\n      rolling {\n        year\n        month\n        windowDays\n        summary\n        releaseCount\n        generatedAt\n      }\n      monthly {\n        year\n        month\n        windowDays\n        summary\n        releaseCount\n        generatedAt\n      }\n    }\n    org {\n      id\n      slug\n      name\n    }\n    releases(limit: $releaseLimit) {\n      id\n      title\n      version\n      type\n      url\n      publishedAt\n      fetchedAt\n      titleGenerated\n      titleShort\n      content\n      summary\n      media {\n        type\n        url\n        alt\n        r2Url\n      }\n    }\n  }\n}",
): (typeof documents)["query SourceDetail($id: String!, $releaseLimit: Int!) {\n  source(id: $id) {\n    id\n    slug\n    name\n    type\n    url\n    productId\n    isHidden\n    discovery\n    metadata\n    changelogUrl\n    hasChangelogFile\n    lastFetchedAt\n    lastPolledAt\n    trackingSince\n    latestVersion\n    latestDate\n    notice {\n      message\n      linkText\n      coordinate\n      href\n    }\n    summaries {\n      rolling {\n        year\n        month\n        windowDays\n        summary\n        releaseCount\n        generatedAt\n      }\n      monthly {\n        year\n        month\n        windowDays\n        summary\n        releaseCount\n        generatedAt\n      }\n    }\n    org {\n      id\n      slug\n      name\n    }\n    releases(limit: $releaseLimit) {\n      id\n      title\n      version\n      type\n      url\n      publishedAt\n      fetchedAt\n      titleGenerated\n      titleShort\n      content\n      summary\n      media {\n        type\n        url\n        alt\n        r2Url\n      }\n    }\n  }\n}"];

export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}

export type DocumentType<TDocumentNode extends DocumentNode<any, any>> =
  TDocumentNode extends DocumentNode<infer TType, any> ? TType : never;
