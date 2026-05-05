import type { MediaItem } from "@buildinternet/releases-api-types";
import { builder } from "../builder.js";

export const MediaType = builder.objectType("Media", {
  description: "An image, video, or GIF attached to a release.",
  fields: (t) => ({
    type: t.exposeString("type"),
    url: t.exposeString("url"),
    alt: t.exposeString("alt", { nullable: true }),
    r2Url: t.exposeString("r2Url", { nullable: true }),
  }),
});

export type { MediaItem };
