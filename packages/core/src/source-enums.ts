/**
 * Source-row enum constants. Lives outside `schema.ts` so consumers (api-types
 * Zod schemas, query row types, worker route validators) can share the canonical
 * value lists without touching the drizzle schema file — keeping the migration
 * pairing CI gate honest. The `sources` table column definitions in schema.ts
 * keep inline literals; drizzle-kit doesn't translate the `enum:` hint into
 * SQL constraints either way, so they stay in sync by convention.
 */

export const SOURCE_TYPES = ["github", "scrape", "feed", "agent", "appstore"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_DISCOVERY = ["curated", "agent", "on_demand"] as const;
export type SourceDiscovery = (typeof SOURCE_DISCOVERY)[number];

export const SOURCE_FETCH_PRIORITIES = ["normal", "low", "paused"] as const;
export type SourceFetchPriority = (typeof SOURCE_FETCH_PRIORITIES)[number];
