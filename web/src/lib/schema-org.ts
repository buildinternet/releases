import type { SourceType } from "@buildinternet/releases-core/source-enums";

/** Most recent activity timestamp for an org or source row. Falls back from
 *  the successful-fetch timestamp to the most-recent-poll timestamp so we
 *  still emit a `dateModified` even when polling hasn't produced new content
 *  in a while. */
export function lastModifiedAt(entity: {
  lastFetchedAt?: string | null;
  lastPolledAt?: string | null;
}): string | undefined {
  return entity.lastFetchedAt ?? entity.lastPolledAt ?? undefined;
}

/**
 * Maps a source's `type` field to the most appropriate schema.org `@type`.
 *
 * - `github`  → SoftwareApplication (carries softwareVersion cleanly)
 * - `feed`    → WebSite
 * - `scrape`  → WebSite
 * - `agent`   → CreativeWork
 */
export function sourceJsonLdType(sourceType: SourceType): string {
  switch (sourceType) {
    case "github":
      return "SoftwareApplication";
    case "feed":
    case "scrape":
      return "WebSite";
    case "agent":
      return "CreativeWork";
    default:
      return "Thing";
  }
}

type SourceEntityInput = {
  name: string;
  type: SourceType;
  latestVersion?: string | null;
  org: { name: string } | null;
  lastFetchedAt?: string | null;
  lastPolledAt?: string | null;
};

/**
 * Builds the primary entity JSON-LD object for a source page.
 * `softwareVersion` is only included when the `@type` is `SoftwareApplication`
 * (i.e. `source.type === "github"`).
 */
export function buildSourceEntityJsonLd(
  source: SourceEntityInput,
  sourceUrl: string,
): Record<string, unknown> {
  const type = sourceJsonLdType(source.type);
  const lastModified = lastModifiedAt(source);

  return {
    "@type": type,
    name: source.name,
    url: sourceUrl,
    ...(type === "SoftwareApplication" && source.latestVersion != null
      ? { softwareVersion: source.latestVersion }
      : {}),
    ...(source.org ? { publisher: { "@type": "Organization", name: source.org.name } } : {}),
    ...(lastModified ? { dateModified: lastModified } : {}),
  };
}
