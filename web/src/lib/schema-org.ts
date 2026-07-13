import type { SourceType } from "@buildinternet/releases-core/source-enums";

/** Current month + year (e.g. "May 2026") in `en-US`, for freshness signals in
 *  feed-page titles and descriptions. Pinned to UTC so the period doesn't drift
 *  by a day at month boundaries depending on the runtime's local timezone.
 *  Recomputed per render, so keep the surfaces that call it on a revalidation
 *  cadence or the period freezes stale. */
export function currentPeriod(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
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
    // release node back at this entity via `isPartOf`.
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

/**
 * Builds the `BreadcrumbList.itemListElement` array for a source sub-page
 * (e.g. /highlights or /changelog). The org breadcrumb is included only when
 * the source has a resolved org.
 *
 * Pure helper (no route coupling), shared by both the `[orgSlug]/[slug]`
 * and ID-keyed `/sources/[id]` source surfaces.
 */
export function sourceBreadcrumbItems(
  source: { name: string; org: { slug: string; name: string } | null },
  sourceUrl: string,
  pageName: string,
  pageUrl: string,
): object[] {
  const home = { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL };
  if (source.org) {
    return [
      home,
      {
        "@type": "ListItem",
        position: 2,
        name: source.org.name,
        item: `${SITE_URL}/${source.org.slug}`,
      },
      { "@type": "ListItem", position: 3, name: source.name, item: sourceUrl },
      { "@type": "ListItem", position: 4, name: pageName, item: pageUrl },
    ];
  }
  return [
    home,
    { "@type": "ListItem", position: 2, name: source.name, item: sourceUrl },
    { "@type": "ListItem", position: 3, name: pageName, item: pageUrl },
  ];
}

/** Subset of a release feed item needed to render a release (`TechArticle`) node.
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
 * Builds an `ItemList` of release (`TechArticle`) nodes for a feed page's JSON-LD
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
          // `SoftwareRelease` is not a real schema.org type — each release note
          // is a `TechArticle` (and the `/release/{id}` page it links to is one
          // too, per #1630). `version` is the valid CreativeWork property here;
          // `softwareVersion` only exists on `SoftwareApplication`.
          "@type": "TechArticle",
          name: release.title,
          url,
          ...(release.publishedAt ? { datePublished: release.publishedAt } : {}),
          ...(release.version ? { version: release.version } : {}),
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

/** Subset of an org needed for the catalog `ItemList`. */
type CatalogOrgInput = { slug: string; name: string };

/**
 * Builds the JSON-LD `@graph` for the A-to-Z org catalog page (`/catalog`):
 * a `CollectionPage`, a `BreadcrumbList` (Home → page), and an `ItemList` of
 * `Organization` nodes (one per tracked org, linking to its releases.sh page).
 * Mirrors {@link buildFeedPageJsonLd} so catalog structured data stays
 * consistent with the feed pages and shares the canonical {@link SITE_URL}.
 * `orgs` should be passed in display order so the list mirrors the page.
 */
export function buildOrgCatalogJsonLd(
  orgs: readonly CatalogOrgInput[],
  opts: { path: string; name: string; description: string },
): Record<string, unknown> {
  const pageUrl = `${SITE_URL}${opts.path}`;
  const pageNodeId = `${pageUrl}#page`;
  const listId = `${pageUrl}#orgs`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        "@id": pageNodeId,
        name: opts.name,
        url: pageUrl,
        description: opts.description,
        mainEntity: { "@id": listId },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: opts.name, item: pageUrl },
        ],
      },
      {
        "@type": "ItemList",
        "@id": listId,
        name: opts.name,
        numberOfItems: orgs.length,
        itemListElement: orgs.map((org, index) => {
          const orgUrl = `${SITE_URL}/${org.slug}`;
          return {
            "@type": "ListItem",
            position: index + 1,
            item: { "@type": "Organization", "@id": orgUrl, name: org.name, url: orgUrl },
          };
        }),
      },
    ],
  };
}

/**
 * schema.org node for an org overview's provenance (#1934). A CreativeWork whose
 * `citation` array points at the on-registry release pages the overview drew on,
 * declaring it a derivative aggregation of internal sources — machine-readable
 * provenance that reinforces the internal-link graph (#1601).
 *
 * Only internal (release-page) citations are declared; external-only sources are
 * omitted. Returns `null` when nothing resolved to a release page, so callers can
 * skip emitting an empty node.
 */
/**
 * schema.org `@graph` for a weekly collection digest page (WS3): an `Article`
 * node — NOT `TechArticle`-with-`sameAs` like a release page, because a
 * digest is first-party editorial content, not a mirror of an external
 * release note — plus a `BreadcrumbList`.
 *
 * `mentions` links out to every covered release's canonical `/release/*`
 * page, reinforcing the internal-link graph (#1601) the same way
 * `buildOverviewCitationJsonLd` does for org overviews.
 */
export function buildDigestJsonLd(
  digest: {
    title: string;
    intro: string;
    weekEndDate: string;
    generatedAt: string;
    releaseUrls: readonly string[];
  },
  opts: {
    pageUrl: string;
    collectionName: string;
    collectionUrl: string;
    /** Index of past digests for this collection (`/collections/:slug/digest`). */
    digestsIndexUrl: string;
  },
): Record<string, unknown> {
  const pageNodeId = `${opts.pageUrl}#article`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": pageNodeId,
        headline: digest.title,
        description: digest.intro,
        url: opts.pageUrl,
        datePublished: digest.weekEndDate,
        dateModified: digest.generatedAt,
        author: { "@type": "Organization", name: "Releases", url: SITE_URL },
        publisher: { "@type": "Organization", name: "Releases", url: SITE_URL },
        about: { "@type": "CollectionPage", name: opts.collectionName, url: opts.collectionUrl },
        ...(digest.releaseUrls.length > 0
          ? { mentions: digest.releaseUrls.map((url) => ({ "@type": "TechArticle", url })) }
          : {}),
      },
      {
        "@type": "BreadcrumbList",
        // Home → Collections → {collection} → Weekly digests → this week.
        // Visible UI stops at "Weekly digests" (current page is the H1).
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          {
            "@type": "ListItem",
            position: 2,
            name: "Collections",
            item: `${SITE_URL}/collections`,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: opts.collectionName,
            item: opts.collectionUrl,
          },
          {
            "@type": "ListItem",
            position: 4,
            name: "Weekly digests",
            item: opts.digestsIndexUrl,
          },
          { "@type": "ListItem", position: 5, name: digest.title, item: opts.pageUrl },
        ],
      },
    ],
  };
}

export function buildOverviewCitationJsonLd(
  citations: readonly { releaseWebUrl?: string | null }[] | undefined | null,
  opts: { orgName: string; aboutId: string; dateModified?: string | null },
): Record<string, unknown> | null {
  const urls = Array.from(
    new Set((citations ?? []).map((c) => c.releaseWebUrl).filter((u): u is string => !!u)),
  );
  if (urls.length === 0) return null;
  return {
    "@type": "CreativeWork",
    name: `${opts.orgName} — Recently Shipped`,
    about: { "@id": opts.aboutId },
    ...(opts.dateModified ? { dateModified: opts.dateModified } : {}),
    citation: urls.map((url) => ({ "@type": "WebPage", url })),
  };
}
