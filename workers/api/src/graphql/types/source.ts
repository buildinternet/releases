import { builder } from "../builder.js";
import { SourceTypeEnum, VideoProviderEnum, AppStorePlatformEnum } from "./enums.js";
import { appStoreSourceInfo } from "@releases/adapters/appstore";
import { videoSourceInfo } from "@releases/adapters/source-meta";
import { parseNotice } from "@buildinternet/releases-core/notice";

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

// Shared by Source.notice and Product.notice — a small curator-set note
// stored under the entity's `metadata.notice` key. See packages/core/src/notice.ts.
builder.objectType("EntityNotice", {
  description: "A small curator-set note attached to an org, product, or source.",
  fields: (t) => ({
    message: t.exposeString("message"),
    linkText: t.exposeString("linkText", { nullable: true }),
    coordinate: t.exposeString("coordinate", { nullable: true }),
    href: t.exposeString("href", { nullable: true }),
  }),
});

builder.objectType("ReleaseSummaryItem", {
  description: "An AI-generated rolling or monthly summary for a source.",
  fields: (t) => ({
    year: t.exposeInt("year", { nullable: true }),
    month: t.exposeInt("month", { nullable: true }),
    windowDays: t.exposeInt("windowDays", { nullable: true }),
    summary: t.exposeString("summary"),
    releaseCount: t.exposeInt("releaseCount"),
    generatedAt: t.expose("generatedAt", { type: "DateTime" }),
  }),
});

builder.objectType("SourceSummaries", {
  description: "Rolling (always-current) and monthly AI-generated summaries for a source.",
  fields: (t) => ({
    rolling: t.field({ type: "ReleaseSummaryItem", nullable: true, resolve: (s) => s.rolling }),
    monthly: t.field({ type: ["ReleaseSummaryItem"], resolve: (s) => s.monthly }),
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
    lastPolledAt: t.expose("lastPolledAt", { type: "DateTime", nullable: true }),
    medianGapDays: t.exposeFloat("medianGapDays", { nullable: true }),
    discovery: t.exposeString("discovery"),
    isHidden: t.exposeBoolean("isHidden", { nullable: true }),
    createdAt: t.expose("createdAt", { type: "DateTime" }),
    productId: t.exposeString("productId", { nullable: true }),
    isHidden: t.field({ type: "Boolean", resolve: (s) => Boolean(s.isHidden) }),

    // Raw `metadata` JSON blob. Web reads admin-only sub-fields
    // (marketingFilter, feedContentDepth, appStore/video info) client-side —
    // mirrors REST's `source.metadata` passthrough rather than exposing every
    // sub-key as its own typed field.
    metadata: t.field({ type: "String", resolve: (s) => s.metadata ?? "{}" }),

    notice: t.field({
      type: "EntityNotice",
      nullable: true,
      resolve: (s) => parseNotice(s.metadata),
    }),

    changelogUrl: t.field({
      type: "String",
      nullable: true,
      resolve: (s) => {
        try {
          const parsed = JSON.parse(s.metadata || "{}") as { changelogUrl?: unknown };
          return typeof parsed.changelogUrl === "string" ? parsed.changelogUrl : null;
        } catch {
          return null;
        }
      },
    }),

    hasChangelogFile: t.field({
      type: "Boolean",
      resolve: (s, _args, ctx) => ctx.loaders.hasChangelogFileBySourceId.load(s.id),
    }),

    trackingSince: t.field({
      type: "DateTime",
      description:
        "Earliest published release date for this source, falling back to when the source row was created.",
      resolve: async (s, _args, ctx) => {
        const earliest = await ctx.loaders.trackingSinceBySourceId.load(s.id);
        return earliest ?? s.createdAt;
      },
    }),

    summaries: t.field({
      type: "SourceSummaries",
      resolve: (s, _args, ctx) => ctx.loaders.summariesBySourceId.load(s.id),
    }),

    // Derived from the same recent-releases batch `releases` reads (dataloader
    // cached — no extra query). Matches the REST first-page derivation in
    // `buildSourceDetailPayload`: the most recent *dated* row's version wins,
    // falling back to the newest row's version when no dated row exists.
    latestVersion: t.field({
      type: "String",
      nullable: true,
      resolve: async (s, _args, ctx) => {
        const recent = await ctx.loaders.releasesBySourceId.load(s.id);
        const latestDated = recent.find((r) => r.publishedAt !== null);
        return latestDated?.version ?? recent[0]?.version ?? null;
      },
    }),

    latestDate: t.field({
      type: "DateTime",
      nullable: true,
      resolve: async (s, _args, ctx) => {
        const recent = await ctx.loaders.releasesBySourceId.load(s.id);
        const latestDated = recent.find((r) => r.publishedAt !== null);
        return latestDated?.publishedAt ?? null;
      },
    }),

    kind: t.exposeString("kind", { nullable: true }),
    isPrimary: t.exposeBoolean("isPrimary", { nullable: true }),
    changeDetectedAt: t.expose("changeDetectedAt", { type: "DateTime", nullable: true }),
    consecutiveNoChange: t.exposeInt("consecutiveNoChange", { nullable: true }),
    consecutiveErrors: t.exposeInt("consecutiveErrors", { nullable: true }),
    nextFetchAfter: t.expose("nextFetchAfter", { type: "DateTime", nullable: true }),
    lastRetieredAt: t.expose("lastRetieredAt", { type: "DateTime", nullable: true }),
    metadata: t.exposeString("metadata", { nullable: true }),
    stars: t.exposeInt("stargazersCount", { nullable: true }),
    starsFetchedAt: t.expose("starsFetchedAt", { type: "DateTime", nullable: true }),

    releaseCount: t.field({
      type: "Int",
      resolve: async (source, _args, ctx) =>
        (await ctx.loaders.sourceStatsBySourceId.load(source.id)).releaseCount,
    }),

    latestVersion: t.field({
      type: "String",
      nullable: true,
      resolve: async (source, _args, ctx) =>
        (await ctx.loaders.sourceStatsBySourceId.load(source.id)).latestVersion,
    }),

    latestDate: t.field({
      type: "DateTime",
      nullable: true,
      resolve: async (source, _args, ctx) =>
        (await ctx.loaders.sourceStatsBySourceId.load(source.id)).latestDate,
    }),

    latestAddedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: async (source, _args, ctx) =>
        (await ctx.loaders.sourceStatsBySourceId.load(source.id)).latestAddedAt,
    }),

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
