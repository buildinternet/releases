import { SOURCE_TYPES } from "../../lib/source-types.js";
import { builder } from "../builder.js";

export const SourceTypeEnum = builder.enumType("SourceType", {
  description:
    "How a source is ingested: GitHub releases API, scraped HTML, parsed feed, or AI agent.",
  values: Object.fromEntries(SOURCE_TYPES.map((v) => [v, { value: v }])),
});

const MEDIA_KINDS = ["image", "video", "gif"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MediaKindEnum = builder.enumType("MediaKind", {
  description: "Kind of media attached to a release.",
  values: Object.fromEntries(MEDIA_KINDS.map((v) => [v, { value: v }])),
});
