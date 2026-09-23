import type { MediaItem } from "@buildinternet/releases-api-types";
import { builder } from "../builder.js";
import { MediaKindEnum, type MediaKind } from "./enums.js";

export const MediaType = builder.objectType("Media", {
  description: "An image, video, or GIF attached to a release.",
  fields: (t) => ({
    type: t.field({
      type: MediaKindEnum,
      resolve: (m) => m.type as MediaKind,
    }),
    url: t.exposeString("url"),
    alt: t.exposeString("alt", { nullable: true }),
    r2Url: t.exposeString("r2Url", { nullable: true }),
    linkUrl: t.exposeString("linkUrl", {
      nullable: true,
      description:
        "Human watch URL for a hosted-video card promoted from an inline body link (Wistia/Loom/Vimeo/YouTube); `url` holds the poster. Absent for ordinary image/gif media.",
    }),
  }),
});

export type { MediaItem };
