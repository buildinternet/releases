import { builder } from "../builder.js";
import { SourceTypeEnum } from "./enums.js";

export const SourceType = builder.objectType("Source", {
  description: "A changelog source (github / scrape / feed / agent).",
  fields: (t) => ({
    id: t.exposeID("id"),
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    type: t.field({ type: SourceTypeEnum, resolve: (s) => s.type }),
    url: t.exposeString("url"),
    fetchPriority: t.exposeString("fetchPriority", { nullable: true }),
    lastFetchedAt: t.expose("lastFetchedAt", { type: "DateTime", nullable: true }),
    medianGapDays: t.exposeFloat("medianGapDays", { nullable: true }),
    discovery: t.exposeString("discovery"),
    createdAt: t.expose("createdAt", { type: "DateTime" }),

    org: t.field({
      type: "Org",
      resolve: async (source, _args, ctx) => {
        const org = await ctx.loaders.orgById.load(source.orgId);
        if (!org) throw new Error(`Org ${source.orgId} not found for source ${source.id}`);
        return org;
      },
    }),

    product: t.field({
      type: "Product",
      nullable: true,
      resolve: (source, _args, ctx) =>
        source.productId ? ctx.loaders.productById.load(source.productId) : null,
    }),

    releases: t.field({
      type: ["Release"],
      description: "Recent non-suppressed releases, newest first. Capped at 50 in the spike.",
      args: {
        limit: t.arg.int({ required: false, defaultValue: 20 }),
      },
      resolve: async (source, args, ctx) => {
        const all = await ctx.loaders.releasesBySourceId.load(source.id);
        const cap = Math.max(1, Math.min(args.limit ?? 20, 50));
        return all.slice(0, cap);
      },
    }),
  }),
});
