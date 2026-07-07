import { builder } from "../builder.js";
import { SourceTypeEnum, VideoProviderEnum, AppStorePlatformEnum } from "./enums.js";
import { appStoreSourceInfo } from "@releases/adapters/appstore";
import { videoSourceInfo } from "@releases/adapters/source-meta";

builder.objectType("AppStoreInfo", {
  description:
    "App Store platform + icon for a `type: appstore` source. Lets clients render the compact app-update treatment (icon + 'Available for iOS/macOS').",
  fields: (t) => ({
    platform: t.field({ type: AppStorePlatformEnum, resolve: (s) => s.platform }),
    iconUrl: t.exposeString("iconUrl", { nullable: true }),
  }),
});

builder.objectType("VideoInfo", {
  description:
    "Video provider for a `type: video` source. Lets clients render the compact video treatment (play badge + 'Watch on YouTube/Vimeo/Wistia').",
  fields: (t) => ({
    provider: t.field({ type: VideoProviderEnum, resolve: (s) => s.provider }),
  }),
});

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
    isHidden: t.exposeBoolean("isHidden", { nullable: true }),
    createdAt: t.expose("createdAt", { type: "DateTime" }),

    appStore: t.field({
      type: "AppStoreInfo",
      nullable: true,
      description: "Platform + icon for App Store sources; null for all other source types. #1206",
      resolve: (s) => appStoreSourceInfo(s.type, s.metadata),
    }),

    video: t.field({
      type: "VideoInfo",
      nullable: true,
      description: "Provider for video sources; null for all other source types. #1206",
      resolve: (s) => videoSourceInfo(s.type, s.metadata),
    }),

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
      description:
        "Recent non-suppressed releases, newest first. The loader fetches up to 50 per source per batch; `limit` clamps to that ceiling.",
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
