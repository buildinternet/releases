import SchemaBuilder from "@pothos/core";
import type { MediaItem, Pagination } from "@buildinternet/releases-api-types";
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
    Pagination: Pagination;
    OrgConnection: OrgConnection;
    ReleaseFeed: ReleaseFeed;
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
