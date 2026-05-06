import { parseReleaseMedia } from "../../utils.js";
import { builder } from "../builder.js";
import { ReleaseTypeEnum } from "./enums.js";

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

    contentSummary: t.exposeString("contentSummary", { nullable: true }),
    content: t.exposeString("content", {
      description:
        "Full markdown body. Often large — request only when you need it (this is the field-selection win).",
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
