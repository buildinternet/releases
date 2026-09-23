/**
 * Client-side locator classification for the claim/promote panel.
 * Mirrors `classifyLocation` in workers/api materialize.ts so the verified
 * owner sees the same tier-1-live / tier-2-review split promote will apply —
 * without a network round-trip. (Cross-org GitHub demotion still happens
 * server-side at promote time; the preview labels github as tier-1.)
 */

import type { ReleaseLocationItem } from "@buildinternet/releases-api-types";

export type LocatorKind = "feed" | "github" | "appstore" | "url" | "file";
export type LocatorClassification = "tier1-live" | "tier2-paused-review";

export type LocatorPreview = {
  kind: LocatorKind;
  locator: string;
  title?: string | null;
  classification: LocatorClassification;
};

export const KIND_LABEL: Record<LocatorKind, string> = {
  feed: "Feed",
  github: "GitHub",
  appstore: "App Store",
  url: "Page",
  file: "File",
};

/** Prefer feed → github → appstore → file → url (same order as materialize). */
const KIND_ORDER: ReadonlyArray<{
  key: LocatorKind;
  classification: LocatorClassification;
}> = [
  { key: "feed", classification: "tier1-live" },
  { key: "github", classification: "tier1-live" },
  { key: "appstore", classification: "tier1-live" },
  { key: "file", classification: "tier2-paused-review" },
  { key: "url", classification: "tier2-paused-review" },
];

export function classifyReleaseLocation(loc: ReleaseLocationItem): LocatorPreview {
  for (const { key, classification } of KIND_ORDER) {
    const locator = loc[key];
    if (locator) {
      return { kind: key, locator, title: loc.title, classification };
    }
  }
  return {
    kind: "url",
    locator: "",
    title: loc.title,
    classification: "tier2-paused-review",
  };
}

export function classifyReleaseLocations(locations: ReleaseLocationItem[]): LocatorPreview[] {
  return locations.map(classifyReleaseLocation).filter((p) => p.locator.length > 0);
}

export function partitionLocatorPreviews(previews: LocatorPreview[]): {
  live: LocatorPreview[];
  queued: LocatorPreview[];
} {
  return {
    live: previews.filter((p) => p.classification === "tier1-live"),
    queued: previews.filter((p) => p.classification === "tier2-paused-review"),
  };
}
