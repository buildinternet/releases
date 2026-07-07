import { builder } from "../builder.js";
import { OrgDiscoveryEnum } from "./enums.js";

export const OrgType = builder.objectType("Org", {
  description: "An organization (the entity that produces one or more products / sources).",
  fields: (t) => ({
    id: t.exposeID("id"),
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    domain: t.exposeString("domain", { nullable: true }),
    description: t.exposeString("description", { nullable: true }),
    category: t.exposeString("category", { nullable: true }),
    avatarUrl: t.exposeString("avatarUrl", { nullable: true }),
    discovery: t.field({ type: OrgDiscoveryEnum, resolve: (o) => o.discovery }),
    isHidden: t.exposeBoolean("isHidden"),
    createdAt: t.expose("createdAt", { type: "DateTime" }),
    updatedAt: t.expose("updatedAt", { type: "DateTime" }),

    products: t.field({
      type: ["Product"],
      resolve: (org, _args, ctx) => ctx.loaders.productsByOrgId.load(org.id),
    }),

    sources: t.field({
      type: ["Source"],
      description:
        "All non-hidden sources for the org. Use Product.sources for product-scoped lists.",
      resolve: (org, _args, ctx) => ctx.loaders.sourcesByOrgId.load(org.id),
    }),
  }),
});
