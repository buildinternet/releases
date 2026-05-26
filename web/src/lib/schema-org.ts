import type { SourceType } from "@buildinternet/releases-core/source-enums";

/** Current month + year (e.g. "May 2026") in `en-US`, for freshness signals in
 *  feed-page titles and descriptions. Recomputed per render, so keep the
 *  surfaces that call it on a revalidation cadence or the period freezes stale. */
export function currentPeriod(): string {
  return new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

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
    // Stable `@id` so an ItemList of releases on the same page can point each
    // `SoftwareRelease` back at this entity via `isPartOf`.
    "@id": sourceUrl,
    name: source.name,
    url: sourceUrl,
    ...(type === "SoftwareApplication" && source.latestVersion != null
      ? { softwareVersion: source.latestVersion }
      : {}),
    ...(source.org ? { publisher: { "@type": "Organization", name: source.org.name } } : {}),
    ...(lastModified ? { dateModified: lastModified } : {}),
  };
}

/** Canonical production origin used for JSON-LD URLs. Matches the hard-coded
 *  `https://releases.sh` origin the page-level structured data already uses, so
 *  emitted nodes always describe the canonical surface (not a preview host). */
const SITE_URL = "https://releases.sh";

/** Subset of a release feed item needed to render a `SoftwareRelease` node.
 *  Structurally satisfied by `OrgReleaseItem`, `CollectionReleaseItem`, and
 *  `CategoryReleaseItem` from `@buildinternet/releases-api-types`. */
type ReleaseListItemInput = {
  id?: string | null;
  title: string;
  version?: string | null;
  publishedAt?: string | null;
  url?: string | null;
};

/**
 * Builds an `ItemList` of `SoftwareRelease` nodes for a feed page's JSON-LD
 * `@graph` (org / source / category / collection feeds). Each release links to
 * its canonical `/release/{id}` page when an `id` is present, falling back to
 * the release's external `url`; rows with neither a usable target are skipped.
 * `isPartOfId` ties each release back to the page's primary entity node
 * (Organization / source entity) via schema.org `isPartOf`. Capped at `limit`
 * (default 20) — the list is an SEO signal, not a full feed mirror.
 */
export function buildReleaseItemListJsonLd(
  releases: readonly ReleaseListItemInput[],
  opts: { listId: string; name: string; isPartOfId?: string; limit?: number },
): Record<string, unknown> {
  const limit = opts.limit ?? 20;
  const itemListElement = releases
    .slice(0, limit)
    .flatMap((release) => {
      const url = release.id ? `${SITE_URL}/release/${release.id}` : (release.url ?? undefined);
      if (!url) return [];
      return [
        {
          "@type": "SoftwareRelease",
          name: release.title,
          url,
          ...(release.publishedAt ? { datePublished: release.publishedAt } : {}),
          ...(release.version ? { softwareVersion: release.version } : {}),
          ...(opts.isPartOfId ? { isPartOf: { "@id": opts.isPartOfId } } : {}),
        },
      ];
    })
    .map((item, index) => ({ "@type": "ListItem", position: index + 1, item }));

  return {
    "@type": "ItemList",
    "@id": opts.listId,
    name: opts.name,
    itemListElement,
  };
}

/**
 * Builds the full JSON-LD `@graph` for a feed collection page (category or
 * collection). Emits three nodes: a `CollectionPage`, a `BreadcrumbList` with a
 * two-level prefix (`Home → sectionName → pageName`), and the `ItemList` of
 * releases produced by `buildReleaseItemListJsonLd`.
 *
 * The caller supplies page-specific values; the stable `#page` / `#releases`
 * fragment IDs are derived internally so call sites stay uniform.
 */
export function buildFeedPageJsonLd(
  releases: readonly ReleaseListItemInput[],
  opts: {
    pageUrl: string;
    name: string;
    description: string;
    /** Label and URL for the middle breadcrumb (e.g. "Categories" + "/categories"). */
    section: { name: string; url: string };
  },
): Record<string, unknown> {
  const pageNodeId = `${opts.pageUrl}#page`;
  const releaseListId = `${opts.pageUrl}#releases`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        "@id": pageNodeId,
        name: opts.name,
        url: opts.pageUrl,
        description: opts.description,
        mainEntity: { "@id": releaseListId },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: opts.section.name, item: opts.section.url },
          { "@type": "ListItem", position: 3, name: opts.name, item: opts.pageUrl },
        ],
      },
      buildReleaseItemListJsonLd(releases, {
        listId: releaseListId,
        name: `${opts.name} releases`,
        isPartOfId: pageNodeId,
      }),
    ],
  };
}
