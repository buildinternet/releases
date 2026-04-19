/**
 * Atom 1.0 (RFC 4287) feed formatters.
 *
 * These build an Atom feed string from the same API response shapes the
 * markdown and JSON formatters consume, so the web, CLI, and MCP can all
 * emit an identical feed.
 */

import type { ReleaseItem, SourceDetail, OrgReleaseItem } from "./api-types.js";

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

// ── Entry builder ────────────────────────────────────────────────────

interface EntryInput {
  release: ReleaseItem;
  sourceSlug: string;
  sourceName: string;
  orgName: string | null;
  linkHref: string | null;
}

function buildEntry(input: EntryInput, baseUrl: string): { xml: string; updated: string | null } {
  const { release, sourceSlug, sourceName, orgName, linkHref } = input;
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
  scope: "org" | "source";
  slug: string;
  title: string;
  subtitle?: string;
  selfUrl: string;
  alternateUrl: string;
  authorName: string;
  entries: EntryInput[];
}

function buildFeed(shell: FeedShell, opts: AtomFeedOptions): string {
  const built = shell.entries
    .slice(0, ATOM_DEFAULT_MAX_ENTRIES)
    .map((e) => buildEntry(e, opts.baseUrl));
  const entriesXml = built.map((b) => b.xml).join("\n");

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
    linkHref: release.id ? `${opts.baseUrl}/release/${release.id}` : release.url,
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
  },
  opts: AtomFeedOptions,
): string {
  const orgPath = `${opts.baseUrl}/${params.orgSlug}`;

  const entries: EntryInput[] = params.releases.map((release) => ({
    release,
    sourceSlug: release.source.slug,
    sourceName: release.source.name,
    orgName: params.orgName,
    linkHref: release.id ? `${opts.baseUrl}/release/${release.id}` : release.url,
  }));

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
    },
    opts,
  );
}
