import { builder } from "../builder.js";

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
  }),
});
