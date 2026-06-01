import {
  SOURCE_DISCOVERY,
  SOURCE_TYPES,
  type SourceDiscovery,
  type SourceType,
} from "@buildinternet/releases-core/source-enums";
import { RELEASE_TYPES, type ReleaseType } from "@buildinternet/releases-core/schema";
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

// Same value list as the SOURCE_DISCOVERY column on `sources`; the SDL name
// is org-scoped because the only field we currently expose it on is
// `Org.discovery`. If we later type `Source.discovery` we can promote this
// to a shared `Discovery` enum.
export const OrgDiscoveryEnum = builder.enumType("OrgDiscovery", {
  description:
    "How an organization entered the registry: hand-curated, materialized by the discovery agent, or created on-demand via /v1/lookups.",
  values: Object.fromEntries(SOURCE_DISCOVERY.map((v) => [v, { value: v }])) as {
    [K in SourceDiscovery]: { value: K };
  },
});

export const ReleaseTypeEnum = builder.enumType("ReleaseType", {
  description:
    "Whether a release is a normal feature/changelog entry or a seasonal/quarterly rollup catch-all.",
  values: Object.fromEntries(RELEASE_TYPES.map((v) => [v, { value: v }])) as {
    [K in ReleaseType]: { value: K };
  },
});

const VIDEO_PROVIDERS = ["youtube", "vimeo", "wistia"] as const;
export const VideoProviderEnum = builder.enumType("VideoProvider", {
  description: "Provider for a video source.",
  values: Object.fromEntries(VIDEO_PROVIDERS.map((v) => [v, { value: v }])) as {
    [K in (typeof VIDEO_PROVIDERS)[number]]: { value: K };
  },
});

const APP_STORE_PLATFORMS = ["ios", "macos"] as const;
export const AppStorePlatformEnum = builder.enumType("AppStorePlatform", {
  description: "App Store platform for an appstore source.",
  values: Object.fromEntries(APP_STORE_PLATFORMS.map((v) => [v, { value: v }])) as {
    [K in (typeof APP_STORE_PLATFORMS)[number]]: { value: K };
  },
});
