import { sql } from "drizzle-orm";
import { parseNotice } from "@buildinternet/releases-core/notice";
import { builder } from "../builder.js";
import { OrgDiscoveryEnum, OrgStatusEnum } from "./enums.js";
import { loadReleaseLocations } from "../../lib/well-known/read-locations.js";
import { listCollectionsWhere } from "../../queries/collections.js";

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

    collections: t.field({
      type: ["Collection"],
      description:
        "Curated collections that pin this org or any of its products, ordered by name. " +
        "Mirrors REST `GET /v1/orgs/:slug/collections` for the org-page 'Featured in' " +
        "sidebar. Preview members omitted (empty) — sidebar only needs identity fields.",
      resolve: async (org, _args, ctx) => {
        const rows = await listCollectionsWhere(
          ctx.db,
          sql`c.id IN (
            SELECT cm.collection_id FROM collection_members cm
            WHERE cm.org_id = ${org.id}
               OR cm.product_id IN (SELECT id FROM products_active WHERE org_id = ${org.id})
          )`,
        );
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

    // List-stats fields below resolve through `orgListStatsByOrgId` /
    // `orgSparklineByOrgId` — batched dataloaders, so a page of orgs costs one
    // query per field, not N.
    recentReleaseCount: t.field({
      type: "Int",
      description: "Releases published in the last 30 days.",
      resolve: async (org, _args, ctx) =>
        (await ctx.loaders.orgListStatsByOrgId.load(org.id)).recentReleaseCount,
    }),

    lastActivity: t.field({
      type: "DateTime",
      nullable: true,
      description: "Most recent release `publishedAt` across the org's sources.",
      resolve: async (org, _args, ctx) =>
        (await ctx.loaders.orgListStatsByOrgId.load(org.id)).lastActivity,
    }),

    topProducts: t.field({
      type: ["String"],
      description: "Up to 3 product names, alphabetical.",
      resolve: async (org, _args, ctx) =>
        (await ctx.loaders.orgListStatsByOrgId.load(org.id)).topProducts,
    }),

    sparkline: t.field({
      type: ["Int"],
      description: "30-day daily release counts, oldest first.",
      resolve: (org, _args, ctx) => ctx.loaders.orgSparklineByOrgId.load(org.id),
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
