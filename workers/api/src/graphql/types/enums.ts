import { SOURCE_TYPES, type SourceType } from "@buildinternet/releases-core/source-enums";
import { builder } from "../builder.js";

// Spell out the values explicitly so Pothos types each enum entry's `value`
// as the literal token rather than widening to `string`. The widening matters
// at the resolver where drizzle's `inArray(sources.type, …)` is gated by the
// SourceType union — passing `string[]` from the resolver fails to typecheck.
export const SourceTypeEnum = builder.enumType("SourceType", {
  description:
    "How a source is ingested: GitHub releases API, scraped HTML, parsed feed, or AI agent.",
  values: Object.fromEntries(SOURCE_TYPES.map((v) => [v, { value: v }])) as {
    [K in SourceType]: { value: K };
  },
});

const MEDIA_KINDS = ["image", "video", "gif"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MediaKindEnum = builder.enumType("MediaKind", {
  description: "Kind of media attached to a release.",
  values: Object.fromEntries(MEDIA_KINDS.map((v) => [v, { value: v }])) as {
    [K in MediaKind]: { value: K };
  },
});
