import type { SourceType } from "@buildinternet/releases-core/source-enums";

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
  const lastModified = source.lastFetchedAt ?? source.lastPolledAt ?? undefined;

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
