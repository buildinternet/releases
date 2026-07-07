import { parseCompositionFromMetadata } from "@buildinternet/releases-core/composition";
import { parseReleaseMedia } from "../../utils.js";
import { builder } from "../builder.js";
import { ReleaseTypeEnum } from "./enums.js";

builder.objectType("ReleaseComposition", {
  description: "Per-category item counts for a release ('12 fixes · 3 features · 1 enhancement').",
  fields: (t) => ({
    bugs: t.exposeInt("bugs"),
    features: t.exposeInt("features"),
    enhancements: t.exposeInt("enhancements"),
  }),
});

export const ReleaseType = builder.objectType("Release", {
  description: "A single release (changelog entry).",
  fields: (t) => ({
    id: t.exposeID("id"),
    title: t.exposeString("title"),
    version: t.exposeString("version", { nullable: true }),
    type: t.field({ type: ReleaseTypeEnum, resolve: (r) => r.type }),
    url: t.exposeString("url", { nullable: true }),
    publishedAt: t.expose("publishedAt", { type: "DateTime", nullable: true }),
    fetchedAt: t.expose("fetchedAt", { type: "DateTime" }),
    prerelease: t.exposeBoolean("prerelease", { nullable: true }),
    breaking: t.exposeString("breaking", { nullable: true }),

    summary: t.exposeString("summary", {
      nullable: true,
      description:
        "AI-generated summary (#852, renamed in #860). Nullable — most rows unpopulated.",
    }),
    titleGenerated: t.exposeString("titleGenerated", {
      nullable: true,
      description:
        "AI-generated self-contained news-headline form (#852, renamed in #860). Nullable; populated opportunistically. Fall back to `title` for display.",
    }),
    titleShort: t.exposeString("titleShort", {
      nullable: true,
      description:
        "AI-generated smart-brevity headline (#852, renamed in #860). Same fallback as `titleGenerated`.",
    }),
    content: t.exposeString("content", {
      description:
        "Full markdown body. Often large — request only when you need it (this is the field-selection win).",
    }),
    migrationNotes: t.exposeString("migrationNotes", {
      nullable: true,
      description:
        "Explicit upgrade/migration steps lifted from the body (#1696); null when the body gives none.",
    }),

    composition: t.field({
      type: "ReleaseComposition",
      nullable: true,
      description: "Per-category item counts from the AI release-content pass, when available.",
      resolve: (release) => parseCompositionFromMetadata(release.metadata ?? null),
    }),

    media: t.field({
      type: ["Media"],
      description: "Images / videos / GIFs attached to the release. Empty list if none.",
      resolve: (release, _args, ctx) => parseReleaseMedia(release.media, ctx.mediaOrigin),
    }),

    source: t.field({
      type: "Source",
      resolve: async (release, _args, ctx) => {
        const source = await ctx.loaders.sourceById.load(release.sourceId);
        if (!source) {
          throw new Error(`Source ${release.sourceId} not found for release ${release.id}`);
        }
        return source;
      },
    }),
  }),
});
