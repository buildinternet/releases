/**
 * Atom 1.0 (RFC 4287) feed formatters.
 *
 * These build an Atom feed string from the same API response shapes the
 * markdown and JSON formatters consume, so the web, CLI, and MCP can all
 * emit an identical feed.
 */

import type {
  ReleaseItem,
  SourceDetail,
  OrgReleaseItem,
  CollectionReleaseItem,
  ReleaseLatestItem,
  CollectionWeeklyDigestListItem,
} from "@buildinternet/releases-api-types";
import { releaseWebUrl } from "@buildinternet/releases-core/release-slug";

export interface AtomFeedOptions {
  /** Canonical base URL, e.g. "https://releases.sh". Required for stable ids. */
  baseUrl: string;
}

/** Default upper bound on entries per feed (spec asks for 20–50). */
export const ATOM_DEFAULT_MAX_ENTRIES = 50;

// ── XML escaping ─────────────────────────────────────────────────────

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeXml(value).replace(/"/g, "&quot;");
}

/** Wrap HTML in CDATA safely, escaping any embedded `]]>` sequence. */
function cdata(html: string): string {
  return `<![CDATA[${html.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

// ── Date normalization ───────────────────────────────────────────────

/**
 * Atom requires RFC 3339 (ISO 8601) timestamps with a timezone. Incoming
 * `publishedAt` values may be date-only (YYYY-MM-DD) from feed sources,
 * full ISO, or null.
 */
function toRfc3339(iso: string | null | undefined): string | null {
  if (!iso) return null;
  // Date-only strings (YYYY-MM-DD) parse as midnight UTC in `new Date()`,
  // which is what we want — normalize everything through toISOString so
  // the output format is always identical (e.g. "…T00:00:00.000Z").
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ── ID generation ────────────────────────────────────────────────────

/**
 * Build a globally unique, stable atom id for a feed entry.
 * Prefer the canonical web URL (release detail page) since it's permanent.
 * Fall back to the release's upstream URL, then to a synthetic tag URI.
 */
function tagAuthority(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "releases.sh";
  }
}

function entryId(
  release: Pick<ReleaseItem, "id" | "url" | "version" | "title" | "publishedAt">,
  sourceSlug: string,
  baseUrl: string,
): string {
  if (release.id) return `${baseUrl}/release/${release.id}`;
  if (release.url) return release.url;
  const fragment = release.version ?? release.title ?? release.publishedAt ?? "unknown";
  return `tag:${tagAuthority(baseUrl)},2005:${sourceSlug}/${encodeURIComponent(fragment)}`;
}

/** Build a feed-level id: a permanent tag URI tied to the feed identity. */
function feedId(scope: string, slug: string, baseUrl: string): string {
  return `tag:${tagAuthority(baseUrl)},2005:${scope}/${slug}`;
}

/**
 * Human-facing canonical link for an entry's `<link rel="alternate">`: the
 * slugged release path (`/release/<id>-<slug>`) for crawler/AI legibility
 * (#1906), falling back to the release's upstream URL when there's no id.
 * The atom `<id>` stays the bare `/release/<id>` form (see `entryId`) so a
 * churning title-derived slug never re-notifies readers.
 */
function releaseAlternateHref(
  release: Pick<ReleaseItem, "id" | "url" | "titleShort" | "titleGenerated" | "title" | "version">,
  baseUrl: string,
): string | null {
  const { id } = release;
  if (!id) return release.url ?? null;
  return releaseWebUrl(baseUrl, { ...release, id });
}

// ── Entry builder ────────────────────────────────────────────────────

interface EntryInput {
  release: ReleaseItem;
  sourceSlug: string;
  sourceName: string;
  orgName: string | null;
}

function buildEntry(input: EntryInput, baseUrl: string): { xml: string; updated: string | null } {
  const { release, sourceSlug, sourceName, orgName } = input;
  // The human <link> is the slugged canonical, derived here (symmetric with the
  // bare <id> in `entryId`) so every formatter gets it without restating it.
  const linkHref = releaseAlternateHref(release, baseUrl);
  const published = toRfc3339(release.publishedAt);
  // Atom requires <updated>; when we lack a real timestamp fall back to
  // epoch so the entry is still well-formed rather than dropped.
  const updated = published ?? new Date(0).toISOString();

  const parts: string[] = ["  <entry>"];
  parts.push(`    <id>${escapeXml(entryId(release, sourceSlug, baseUrl))}</id>`);
  const titleText = release.title?.trim() || release.version || "Untitled release";
  parts.push(`    <title>${escapeXml(titleText)}</title>`);
  if (linkHref) {
    parts.push(`    <link rel="alternate" type="text/html" href="${escapeAttr(linkHref)}" />`);
  }
  parts.push(`    <updated>${updated}</updated>`);
  if (published) {
    parts.push(`    <published>${published}</published>`);
  }
  const authorName = orgName ?? sourceName;
  parts.push(`    <author><name>${escapeXml(authorName)}</name></author>`);
  parts.push(`    <category term="${escapeAttr(sourceSlug)}" label="${escapeAttr(sourceName)}" />`);

  const body = release.content || release.summary;
  if (body) {
    parts.push(`    <content type="html">${cdata(body)}</content>`);
  }
  if (release.summary && release.summary !== body) {
    parts.push(`    <summary>${escapeXml(release.summary)}</summary>`);
  }

  parts.push("  </entry>");
  return { xml: parts.join("\n"), updated };
}

// ── Feed assembly ────────────────────────────────────────────────────

interface FeedShell {
  scope: "org" | "source" | "collection" | "category" | "product" | "user";
  slug: string;
  title: string;
  subtitle?: string;
  selfUrl: string;
  alternateUrl: string;
  authorName: string;
  entries: EntryInput[];
  /** Pre-rendered entry inserted at the top of the feed (e.g. org overview). */
  pinnedEntry?: string | null;
}

function buildFeed(shell: FeedShell, opts: AtomFeedOptions): string {
  const built = shell.entries
    .slice(0, ATOM_DEFAULT_MAX_ENTRIES)
    .map((e) => buildEntry(e, opts.baseUrl));
  const releaseEntriesXml = built.map((b) => b.xml).join("\n");
  const entriesXml = shell.pinnedEntry
    ? [shell.pinnedEntry, releaseEntriesXml].filter(Boolean).join("\n")
    : releaseEntriesXml;

  // Feed <updated> must reflect the newest entry's timestamp; if there are
  // no entries, use "now" so the feed is still valid.
  const mostRecent = built
    .map((b) => b.updated)
    .filter((t): t is string => Boolean(t))
    .toSorted()
    .toReversed()[0];
  const feedUpdated = mostRecent ?? new Date().toISOString();

  const header = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:sy="http://purl.org/rss/1.0/modules/syndication/">',
    `  <id>${escapeXml(feedId(shell.scope, shell.slug, opts.baseUrl))}</id>`,
    `  <title>${escapeXml(shell.title)}</title>`,
    shell.subtitle ? `  <subtitle>${escapeXml(shell.subtitle)}</subtitle>` : "",
    `  <link rel="self" type="application/atom+xml" href="${escapeAttr(shell.selfUrl)}" />`,
    `  <link rel="alternate" type="text/html" href="${escapeAttr(shell.alternateUrl)}" />`,
    `  <updated>${feedUpdated}</updated>`,
    `  <author><name>${escapeXml(shell.authorName)}</name></author>`,
    '  <generator uri="https://releases.sh">releases.sh</generator>',
    "  <sy:updatePeriod>hourly</sy:updatePeriod>",
    "  <sy:updateFrequency>1</sy:updateFrequency>",
  ]
    .filter(Boolean)
    .join("\n");

  return `${header}\n${entriesXml}\n</feed>\n`;
}

// ── Public formatters ────────────────────────────────────────────────

/** Atom feed for a single source (within or without an org). */
export function sourceToAtom(source: SourceDetail, opts: AtomFeedOptions): string {
  const orgSlug = source.org?.slug ?? null;
  const orgName = source.org?.name ?? null;
  const sourcePath = orgSlug
    ? `${opts.baseUrl}/${orgSlug}/${source.slug}`
    : `${opts.baseUrl}/source/${source.slug}`;

  const entries: EntryInput[] = source.releases.map((release) => ({
    release,
    sourceSlug: source.slug,
    sourceName: source.name,
    orgName,
  }));

  return buildFeed(
    {
      scope: "source",
      slug: source.slug,
      title: orgName ? `${source.name} release notes — ${orgName}` : `${source.name} release notes`,
      subtitle: `Release notes and changelog for ${source.name}`,
      selfUrl: `${sourcePath}.atom`,
      alternateUrl: sourcePath,
      authorName: orgName ?? source.name,
      entries,
    },
    opts,
  );
}

/** Atom feed for an organization — aggregated releases across sources. */
export function orgReleasesToAtom(
  params: {
    orgSlug: string;
    orgName: string;
    releases: OrgReleaseItem[];
    /** AI-generated overview — surfaced as a pinned entry so agents see it alongside releases. */
    overview?: { content: string; generatedAt: string; updatedAt: string } | null;
  },
  opts: AtomFeedOptions,
): string {
  const orgPath = `${opts.baseUrl}/${params.orgSlug}`;

  const entries: EntryInput[] = params.releases.map((release) => ({
    release,
    sourceSlug: release.source.slug,
    sourceName: release.source.name,
    orgName: params.orgName,
  }));

  const overviewEntry = params.overview
    ? buildOverviewEntry(params.orgSlug, params.orgName, params.overview, opts.baseUrl)
    : null;

  return buildFeed(
    {
      scope: "org",
      slug: params.orgSlug,
      title: `${params.orgName} release notes`,
      subtitle: `${params.orgName} release notes and changelog`,
      selfUrl: `${orgPath}.atom`,
      alternateUrl: orgPath,
      authorName: params.orgName,
      entries,
      pinnedEntry: overviewEntry,
    },
    opts,
  );
}

/** Atom feed for a product — aggregated releases across the product's sources. */
export function productReleasesToAtom(
  params: {
    orgSlug: string;
    productSlug: string;
    productName: string;
    releases: OrgReleaseItem[];
  },
  opts: AtomFeedOptions,
): string {
  // The human page lives at the bare canonical `/[org]/[slug]` (post-#1190),
  // but the feed is served at the `/product/` machine path: bare
  // `/[org]/[slug].atom` routes to the SOURCE formatter via the static
  // route-map, so `self` must point at `/product/` to stay fetchable.
  const productPage = `${opts.baseUrl}/${params.orgSlug}/${params.productSlug}`;
  const feedPath = `${opts.baseUrl}/${params.orgSlug}/product/${params.productSlug}`;

  const entries: EntryInput[] = params.releases.map((release) => ({
    release,
    sourceSlug: release.source.slug,
    sourceName: release.source.name,
    orgName: params.productName,
  }));

  return buildFeed(
    {
      scope: "product",
      slug: `${params.orgSlug}/${params.productSlug}`,
      title: `${params.productName} release notes`,
      subtitle: `${params.productName} release notes and changelog`,
      selfUrl: `${feedPath}.atom`,
      alternateUrl: productPage,
      authorName: params.productName,
      entries,
    },
    opts,
  );
}

/**
 * Atom feed for a signed-in user's personalized follows feed. Aggregates
 * releases across every org/product they follow. The feed is served behind a
 * tokenized URL (`selfUrl`); `lookupId` (non-secret) seeds a stable feed id so
 * the id never embeds the secret. `alternateUrl` points at the web /following page.
 */
export function userFeedToAtom(
  params: { releases: ReleaseLatestItem[]; lookupId: string; selfUrl: string },
  opts: AtomFeedOptions,
): string {
  const entries: EntryInput[] = params.releases.map((release) => ({
    release: release as ReleaseItem,
    sourceSlug: release.source.slug,
    sourceName: release.source.name,
    orgName: null,
  }));

  return buildFeed(
    {
      scope: "user",
      slug: params.lookupId,
      title: "Your followed releases",
      subtitle: "Releases from the organizations and products you follow on Releases.",
      selfUrl: params.selfUrl,
      alternateUrl: `${opts.baseUrl}/following`,
      authorName: "Releases",
      entries,
    },
    opts,
  );
}

function aggregateReleaseEntries(releases: CollectionReleaseItem[], baseUrl: string): EntryInput[] {
  return releases.map((release) => ({
    release,
    sourceSlug: release.source.slug,
    sourceName: release.source.name,
    orgName: release.org.name,
  }));
}

/** Atom feed for a category rollup — aggregated releases across all orgs/products in the category. */
export function categoryReleasesToAtom(
  params: {
    categorySlug: string;
    categoryName: string;
    releases: CollectionReleaseItem[];
  },
  opts: AtomFeedOptions,
): string {
  const path = `${opts.baseUrl}/categories/${params.categorySlug}`;
  return buildFeed(
    {
      scope: "category",
      slug: params.categorySlug,
      title: `${params.categoryName} — releases`,
      subtitle: `Aggregated releases from organizations and products in the ${params.categoryName} category`,
      selfUrl: `${path}.atom`,
      alternateUrl: path,
      authorName: params.categoryName,
      entries: aggregateReleaseEntries(params.releases, opts.baseUrl),
    },
    opts,
  );
}

/** Atom feed for a collection — aggregated releases across multiple member orgs. */
export function collectionReleasesToAtom(
  params: {
    collectionSlug: string;
    collectionName: string;
    description: string | null;
    releases: CollectionReleaseItem[];
  },
  opts: AtomFeedOptions,
): string {
  const path = `${opts.baseUrl}/collections/${params.collectionSlug}`;
  return buildFeed(
    {
      scope: "collection",
      slug: params.collectionSlug,
      title: `${params.collectionName} — releases`,
      subtitle:
        params.description ?? `Aggregated releases from organizations in ${params.collectionName}`,
      selfUrl: `${path}.atom`,
      alternateUrl: path,
      authorName: params.collectionName,
      entries: aggregateReleaseEntries(params.releases, opts.baseUrl),
    },
    opts,
  );
}

/**
 * Atom feed of weekly collection digests (`/collections/:slug/digest.atom`).
 * Aggregate only — same pattern as org/source/collection release feeds. There
 * is no per-week Atom document; individual digests are md/json like overviews.
 */
export function collectionDigestsToAtom(
  params: {
    collectionSlug: string;
    collectionName: string;
    description?: string | null;
    digests: Array<
      Pick<CollectionWeeklyDigestListItem, "weekStart" | "title" | "intro" | "generatedAt">
    >;
  },
  opts: AtomFeedOptions,
): string {
  const indexPath = `${opts.baseUrl}/collections/${params.collectionSlug}/digest`;
  const digests = params.digests.slice(0, ATOM_DEFAULT_MAX_ENTRIES);

  const entryXml = digests.map((d) => {
    const pageUrl = `${indexPath}/${d.weekStart}`;
    const updated = toRfc3339(d.generatedAt) ?? new Date(0).toISOString();
    // Stable id on the week path (not title) so a re-title doesn't re-notify.
    const parts: string[] = ["  <entry>"];
    parts.push(`    <id>${escapeXml(pageUrl)}</id>`);
    parts.push(`    <title>${escapeXml(d.title)}</title>`);
    parts.push(`    <link rel="alternate" type="text/html" href="${escapeAttr(pageUrl)}" />`);
    parts.push(
      `    <link rel="alternate" type="text/markdown" href="${escapeAttr(`${pageUrl}.md`)}" />`,
    );
    parts.push(`    <updated>${updated}</updated>`);
    parts.push(`    <published>${updated}</published>`);
    parts.push(`    <author><name>${escapeXml(params.collectionName)}</name></author>`);
    parts.push(`    <category term="digest" label="Weekly digest" />`);
    if (d.intro) {
      parts.push(`    <summary>${escapeXml(d.intro)}</summary>`);
      parts.push(`    <content type="text">${escapeXml(d.intro)}</content>`);
    }
    parts.push("  </entry>");
    return { xml: parts.join("\n"), updated };
  });

  const mostRecent = entryXml
    .map((e) => e.updated)
    .filter(Boolean)
    .toSorted()
    .toReversed()[0];
  const feedUpdated = mostRecent ?? new Date().toISOString();

  const header = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:sy="http://purl.org/rss/1.0/modules/syndication/">',
    `  <id>${escapeXml(feedId("collection-digest", params.collectionSlug, opts.baseUrl))}</id>`,
    `  <title>${escapeXml(`${params.collectionName} — weekly digests`)}</title>`,
    `  <subtitle>${escapeXml(
      params.description ?? `Weekly editorial digests for ${params.collectionName}`,
    )}</subtitle>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeAttr(`${indexPath}.atom`)}" />`,
    `  <link rel="alternate" type="text/html" href="${escapeAttr(indexPath)}" />`,
    `  <updated>${feedUpdated}</updated>`,
    `  <author><name>${escapeXml(params.collectionName)}</name></author>`,
    '  <generator uri="https://releases.sh">releases.sh</generator>',
    "  <sy:updatePeriod>weekly</sy:updatePeriod>",
    "  <sy:updateFrequency>1</sy:updateFrequency>",
  ].join("\n");

  return `${header}\n${entryXml.map((e) => e.xml).join("\n")}\n</feed>\n`;
}

function buildOverviewEntry(
  orgSlug: string,
  orgName: string,
  overview: { content: string; generatedAt: string; updatedAt: string },
  baseUrl: string,
): string {
  const updated =
    toRfc3339(overview.updatedAt) ?? toRfc3339(overview.generatedAt) ?? new Date().toISOString();
  const published = toRfc3339(overview.generatedAt) ?? updated;
  const linkHref = `${baseUrl}/${orgSlug}/overview.md`;
  const id = `tag:${tagAuthority(baseUrl)},2005:${orgSlug}/overview`;

  const parts: string[] = ["  <entry>"];
  parts.push(`    <id>${escapeXml(id)}</id>`);
  parts.push(`    <title>${escapeXml(`${orgName} — overview`)}</title>`);
  parts.push(`    <link rel="alternate" type="text/markdown" href="${escapeAttr(linkHref)}" />`);
  parts.push(`    <updated>${updated}</updated>`);
  parts.push(`    <published>${published}</published>`);
  parts.push(`    <author><name>${escapeXml(orgName)}</name></author>`);
  parts.push(`    <category term="overview" label="Overview" />`);
  parts.push(`    <content type="text">${escapeXml(overview.content)}</content>`);
  parts.push("  </entry>");
  return parts.join("\n");
}
