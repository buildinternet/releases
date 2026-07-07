import SchemaBuilder from "@pothos/core";
import type {
  MediaItem,
  Pagination,
  CollectionMemberOrg as CollectionMemberOrgWire,
  CollectionMemberProduct as CollectionMemberProductWire,
  ProductParentOrg,
} from "@buildinternet/releases-api-types";
import type { ReleaseComposition } from "@buildinternet/releases-core/composition";
import type { Notice } from "@buildinternet/releases-core/notice";
import type { D1Db } from "../db.js";
import type { Loaders, Org, Product, Release, Source } from "./loaders.js";

export type GraphQLContext = {
  db: D1Db;
  loaders: Loaders;
  isAdmin: boolean;
  /** Origin used to resolve `r2Key` → public `r2Url` for release media. */
  mediaOrigin: string;
};

export type OrgConnection = { items: Org[]; pagination: Pagination };
export type ReleaseFeed = { items: Release[]; nextCursor: string | null };
/** App Store platform + icon for `type: appstore` sources. Shape mirrors
 *  `appStoreSourceInfo` in packages/adapters and `AppStoreSourceInfoSchema`. */
export type AppStoreInfo = { platform: "ios" | "macos"; iconUrl: string | null };
/** Video provider for `type: video` sources. Shape mirrors `videoSourceInfo`
 *  in packages/adapters and `VideoSourceInfoSchema`. */
export type VideoInfo = { provider: "youtube" | "vimeo" | "wistia" };
/** A linked social/platform account for an org. Mirrors `OrgAccountItemSchema`. */
export type OrgAccount = { platform: string; handle: string };
/** Flat registry rollup — the wire shape the homepage banner reads. Subset of
 *  REST `/v1/stats`'s back-compat flat fields; the richer `StatsSummary`
 *  fields (sourceHealth, sourceActivity, …) aren't GraphQL homepage needs. */
export type Stats = { orgs: number; sources: number; releases: number };
export type CollectionMemberOrg = CollectionMemberOrgWire & { kind: "org" };
export type CollectionMemberProduct = CollectionMemberProductWire & { kind: "product" };
export type CollectionMember = CollectionMemberOrg | CollectionMemberProduct;
export type Collection = {
  slug: string;
  name: string;
  description: string | null;
  memberCount: number;
  isFeatured: boolean;
  previewMembers: CollectionMember[];
};
/** A rolling or monthly AI-generated summary row. Mirrors `ReleaseSummaryItemSchema`. */
export type ReleaseSummaryItem = {
  year: number | null;
  month: number | null;
  windowDays: number | null;
  summary: string;
  releaseCount: number;
  generatedAt: string;
};
export type SourceSummaries = { rolling: ReleaseSummaryItem | null; monthly: ReleaseSummaryItem[] };

export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  // Default to non-null fields and lists. Pothos defaults to nullable, which
  // forces every codegen consumer through layers of optional chaining for
  // columns that the DB guarantees. Opt into nullability explicitly per field.
  DefaultFieldNullability: false;
  DefaultInputFieldRequiredness: false;
  Objects: {
    Org: Org;
    Product: Product;
    Source: Source;
    Release: Release;
    Media: MediaItem;
    AppStoreInfo: AppStoreInfo;
    VideoInfo: VideoInfo;
    ReleaseComposition: ReleaseComposition;
    OrgAccount: OrgAccount;
    Pagination: Pagination;
    OrgConnection: OrgConnection;
    ReleaseFeed: ReleaseFeed;
    Stats: Stats;
    Collection: Collection;
    CollectionMemberOrg: CollectionMemberOrg;
    CollectionMemberProduct: CollectionMemberProduct;
    CollectionMemberProductOrg: ProductParentOrg;
    EntityNotice: Notice;
    ReleaseSummaryItem: ReleaseSummaryItem;
    SourceSummaries: SourceSummaries;
  };
  Scalars: {
    ID: { Input: string; Output: string };
    DateTime: { Input: string; Output: string };
    JSON: { Input: unknown; Output: unknown };
  };
}>({
  defaultFieldNullability: false,
});

builder.objectType("Pagination", {
  description: "Page-based pagination envelope. Mirrors REST's Pagination shape.",
  fields: (t) => ({
    page: t.exposeInt("page"),
    pageSize: t.exposeInt("pageSize"),
    returned: t.exposeInt("returned"),
    totalItems: t.exposeInt("totalItems", { nullable: true }),
    totalPages: t.exposeInt("totalPages", { nullable: true }),
    hasMore: t.exposeBoolean("hasMore", { nullable: true }),
  }),
});

builder.objectType("OrgConnection", {
  description: "Catalog-shaped page of organizations.",
  fields: (t) => ({
    items: t.field({ type: ["Org"], resolve: (c) => c.items }),
    pagination: t.field({ type: "Pagination", resolve: (c) => c.pagination }),
  }),
});

builder.objectType("ReleaseFeed", {
  description: "Feed-shaped page of releases. `nextCursor` is null when the feed is exhausted.",
  fields: (t) => ({
    items: t.field({ type: ["Release"], resolve: (f) => f.items }),
    nextCursor: t.exposeString("nextCursor", { nullable: true }),
  }),
});

builder.scalarType("DateTime", {
  serialize: (value) => String(value),
  parseValue: (value) => {
    if (typeof value !== "string") throw new Error("DateTime must be ISO-8601 string");
    return value;
  },
});

builder.scalarType("JSON", {
  serialize: (value) => value,
  parseValue: (value) => value,
});
