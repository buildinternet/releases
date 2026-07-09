import { sql } from "drizzle-orm";
import { builder } from "../builder.js";
import { parseNotice } from "@buildinternet/releases-core/notice";
import { listCollectionsWhere } from "../../queries/collections.js";

export const ProductType = builder.objectType("Product", {
  description: "Optional grouping layer between an Org and its Sources.",
  fields: (t) => ({
    id: t.exposeID("id"),
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    url: t.exposeString("url", { nullable: true }),
    description: t.exposeString("description", { nullable: true }),
    category: t.exposeString("category", { nullable: true }),
    kind: t.exposeString("kind", { nullable: true }),
    createdAt: t.expose("createdAt", { type: "DateTime" }),

    sourceCount: t.field({
      type: "Int",
      resolve: async (product, _args, ctx) =>
        (await ctx.loaders.productStatsByProductId.load(product.id)).sourceCount,
    }),

    releaseCount: t.field({
      type: "Int",
      resolve: async (product, _args, ctx) =>
        (await ctx.loaders.productStatsByProductId.load(product.id)).releaseCount,
    }),

    tags: t.field({
      type: ["String"],
      description: "Tag names attached to the product, alphabetized.",
      resolve: (product, _args, ctx) => ctx.loaders.tagsByProductId.load(product.id),
    }),

    notice: t.field({
      type: "EntityNotice",
      nullable: true,
      resolve: (product) => parseNotice(product.metadata),
    }),

    org: t.field({
      type: "Org",
      resolve: async (product, _args, ctx) => {
        const org = await ctx.loaders.orgById.load(product.orgId);
        if (!org) throw new Error(`Org ${product.orgId} not found for product ${product.id}`);
        return org;
      },
    }),

    sources: t.field({
      type: ["Source"],
      resolve: (product, _args, ctx) => ctx.loaders.sourcesByProductId.load(product.id),
    }),

    collections: t.field({
      type: ["Collection"],
      description:
        "Curated collections that pin this product, ordered by name. Mirrors REST " +
        "`GET /v1/orgs/:slug/products/:productSlug/collections` for the product-page " +
        "'Featured in' sidebar. Preview members are omitted (empty) — the sidebar only " +
        "needs identity fields.",
      resolve: async (product, _args, ctx) => {
        const rows = await listCollectionsWhere(
          ctx.db,
          sql`c.id IN (SELECT cm.collection_id FROM collection_members cm WHERE cm.product_id = ${product.id})`,
        );
        // GraphQL Collection requires previewMembers; listCollectionsWhere is the
        // sidebar-shaped list without previews. Empty array is intentional.
        return rows.map((r) => ({
          slug: r.slug,
          name: r.name,
          description: r.description,
          memberCount: r.memberCount,
          isFeatured: r.isFeatured,
          previewMembers: [],
        }));
      },
    }),
  }),
});
