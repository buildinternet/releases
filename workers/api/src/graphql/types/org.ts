import { parseNotice } from "@buildinternet/releases-core/notice";
import { builder } from "../builder.js";
import { OrgDiscoveryEnum, OrgStatusEnum } from "./enums.js";
import { loadReleaseLocations } from "../../lib/well-known/read-locations.js";

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

    autoGenerateContent: t.exposeBoolean("autoGenerateContent", { nullable: true }),
    overviewCadenceDays: t.exposeInt("overviewCadenceDays", { nullable: true }),
    featured: t.exposeBoolean("featured", { nullable: true }),
    fetchPaused: t.exposeBoolean("fetchPaused", { nullable: true }),

    // `tier` is the DB column name; the wire field (REST + here) is `status`.
    status: t.field({ type: OrgStatusEnum, resolve: (o) => o.tier }),

    // Declared release locations (#1947) — only non-empty for stub orgs.
    // Same shape as the REST `locations` field; fetched lazily per-org since
    // it only applies to the `stub` tier.
    locations: t.field({
      type: "JSON",
      nullable: true,
      description:
        "Declared release locations for a stub org (empty sources array). Null for tracked orgs.",
      resolve: async (org, _args, ctx) => {
        if (org.tier !== "stub") return null;
        return loadReleaseLocations(ctx.db, org.id);
      },
    }),

    tags: t.field({
      type: ["String"],
      resolve: (org, _args, ctx) => ctx.loaders.orgTagsByOrgId.load(org.id),
    }),

    aliases: t.field({
      type: ["String"],
      resolve: (org, _args, ctx) => ctx.loaders.orgAliasesByOrgId.load(org.id),
    }),

    accounts: t.field({
      type: ["OrgAccount"],
      resolve: (org, _args, ctx) => ctx.loaders.orgAccountsByOrgId.load(org.id),
    }),

    notice: t.field({
      type: "JSON",
      nullable: true,
      resolve: (org) => parseNotice(org.metadata),
    }),

    sourceCount: t.field({
      type: "Int",
      resolve: async (org, _args, ctx) => {
        const sources = await ctx.loaders.sourcesByOrgId.load(org.id);
        return sources.length;
      },
    }),

    releaseCount: t.field({
      type: "Int",
      resolve: async (org, _args, ctx) =>
        (await ctx.loaders.orgStatsByOrgId.load(org.id)).releaseCount,
    }),

    releasesLast30Days: t.field({
      type: "Int",
      resolve: async (org, _args, ctx) =>
        (await ctx.loaders.orgStatsByOrgId.load(org.id)).releasesLast30Days,
    }),

    avgReleasesPerWeek: t.field({
      type: "Float",
      resolve: async (org, _args, ctx) =>
        (await ctx.loaders.orgStatsByOrgId.load(org.id)).avgReleasesPerWeek,
    }),

    lastFetchedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: async (org, _args, ctx) =>
        (await ctx.loaders.orgStatsByOrgId.load(org.id)).lastFetchedAt,
    }),

    lastPolledAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: async (org, _args, ctx) =>
        (await ctx.loaders.orgStatsByOrgId.load(org.id)).lastPolledAt,
    }),

    trackingSince: t.field({
      type: "DateTime",
      resolve: async (org, _args, ctx) =>
        (await ctx.loaders.orgStatsByOrgId.load(org.id)).trackingSince,
    }),

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

builder.objectType("OrgAccount", {
  description: "A linked social/platform account for an org (e.g. github, x).",
  fields: (t) => ({
    platform: t.exposeString("platform"),
    handle: t.exposeString("handle"),
  }),
});
