/**
 * Shared formatters for producing agent-friendly markdown and JSON output.
 *
 * These work on the API response shapes so they can be used identically by
 * the CLI, MCP server, and web frontend.
 */

import type {
  ReleaseItem,
  ReleaseDetail,
  ReleaseSummaryItem,
  SourceDetail,
  SourceListItem,
  OrgDetail,
  OrgReleaseItem,
  ProductDetail,
  UnifiedSearchResponse,
  OverviewPageItem,
  CollectionDetail,
  CollectionReleaseItem,
} from "@buildinternet/releases-api-types";

// Re-export under the old names for any callers still using them
export type FormatRelease = ReleaseItem;
export type FormatReleaseSummary = ReleaseSummaryItem;
export type FormatSourceDetail = SourceDetail;
export type FormatSourceListItem = SourceListItem;
export type FormatOrgDetail = OrgDetail;

export interface FormatOptions {
  /** Base URL for canonical links (e.g. "https://releases.sh") */
  baseUrl?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function attr(key: string, value: string | number | null | undefined): string {
  if (value == null || value === "") return "";
  return ` ${key}="${String(value).replace(/"/g, "&quot;")}"`;
}

function formatIsoDate(iso: string | null): string {
  if (!iso) return "";
  try {
    // Use UTC to avoid timezone-shift issues with date-only ISO strings
    return new Date(iso).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

/** Trim a full ISO timestamp to just the date portion. */
function isoDateOnly(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function yamlLine(key: string, value: string | number | null | undefined): string {
  if (value == null || value === "") return "";
  return `${key}: ${value}`;
}

function yamlScalar(value: string): string {
  // Always quote handles so YAML 1.1 parsers can't coerce values like
  // "true", "123", or "null" to booleans, numbers, or null. Cheaper than
  // enumerating every coercible token, and the cost is two extra chars.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ── Source → Markdown ────────────────────────────────────────────────

export function sourceToMarkdown(source: FormatSourceDetail, opts: FormatOptions = {}): string {
  const lines: string[] = [];

  // ── Frontmatter ──
  const sourcePath = source.org ? `/${source.org.slug}/${source.slug}` : `/source/${source.slug}`;

  lines.push("---");
  lines.push(yamlLine("name", source.name));
  lines.push(yamlLine("slug", source.slug));
  lines.push(yamlLine("type", source.type));
  lines.push(yamlLine("source_url", source.url));
  if (source.changelogUrl) {
    lines.push(yamlLine("changelog_url", source.changelogUrl));
  }
  if (source.org) {
    lines.push(yamlLine("organization", source.org.name));
    lines.push(yamlLine("organization_slug", source.org.slug));
  }
  lines.push(yamlLine("total_releases", source.releaseCount));
  if (source.latestVersion) {
    lines.push(yamlLine("latest_version", source.latestVersion));
  }
  if (source.latestDate) {
    lines.push(yamlLine("latest_date", isoDateOnly(source.latestDate)));
  }
  if (source.lastFetchedAt) {
    lines.push(yamlLine("last_updated", isoDateOnly(source.lastFetchedAt)));
  }
  lines.push(yamlLine("tracking_since", isoDateOnly(source.trackingSince)));

  if (opts.baseUrl) {
    lines.push(yamlLine("canonical", `${opts.baseUrl}${sourcePath}`));
    if (source.org) {
      lines.push(yamlLine("organization_url", `${opts.baseUrl}/${source.org.slug}`));
    }
  }
  lines.push("---");
  lines.push("");

  // ── Summaries ──
  if (source.summaries?.rolling) {
    lines.push(
      `<Summary type="rolling" window-days="${source.summaries.rolling.windowDays}" release-count="${source.summaries.rolling.releaseCount}">`,
    );
    lines.push(source.summaries.rolling.summary);
    lines.push("</Summary>");
    lines.push("");
  }

  for (const monthly of source.summaries?.monthly ?? []) {
    const monthName =
      monthly.month != null && monthly.year != null
        ? new Date(monthly.year, monthly.month - 1).toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
          })
        : "";
    lines.push(
      `<Summary type="monthly"${attr("period", monthName)}${attr("release-count", monthly.releaseCount)}>`,
    );
    lines.push(monthly.summary);
    lines.push("</Summary>");
    lines.push("");
  }

  // ── Releases ──
  for (const release of source.releases) {
    const dateStr = formatIsoDate(release.publishedAt);
    lines.push(
      `<Release${attr("version", release.version)}${attr("date", dateStr)}${attr("published", release.publishedAt)}${attr("url", release.url)}>`,
    );

    // Title as heading if it differs from version
    if (release.title && release.title !== release.version) {
      lines.push(`## ${release.title}`);
      lines.push("");
    }

    // Prefer full content, fall back to summary
    const body = release.content || release.summary;
    if (body) {
      lines.push(body);
    }

    lines.push("</Release>");
    lines.push("");
  }

  // ── Pagination ──
  // The embedded releases array is feed-shaped (append-only, mutates between
  // calls) so it uses cursor pagination. The frontmatter's `total_releases`
  // carries the absolute count; no `total-items` / `total-pages` attribute.
  pushPaginationFooter(
    lines,
    source.pagination,
    opts.baseUrl ? `${opts.baseUrl}${sourcePath}.md` : null,
  );

  return lines.join("\n");
}

// ── Org → Markdown ──────────────────────────────────────────────────

export interface OrgMarkdownOptions extends FormatOptions {
  /** Most recent releases across all sources, rendered as a timeline preview. */
  recentReleases?: OrgReleaseItem[];
}

/**
 * Renders a cross-source "Recent Releases" preview as truncated `<Release>`
 * blocks (summary only, with a `canonical` URL for the full content). Shared
 * by the org and product markdown adapters, both of which aggregate releases
 * across multiple sources.
 */
function pushRecentReleasesSection(
  lines: string[],
  releases: OrgReleaseItem[],
  opts: FormatOptions,
): void {
  if (releases.length === 0) return;
  lines.push("## Recent Releases");
  lines.push("");
  lines.push(
    "_Summaries below — fetch the release's `canonical` URL for full content, or `url` for the original source._",
  );
  lines.push("");
  for (const release of releases) {
    const dateStr = formatIsoDate(release.publishedAt);
    const canonical = opts.baseUrl && release.id ? `${opts.baseUrl}/release/${release.id}` : null;
    lines.push(
      `<Release${attr("source", release.source.slug)}${attr("version", release.version)}${attr("date", dateStr)}${attr("published", release.publishedAt)}${attr("url", release.url)}${attr("canonical", canonical)} truncated="true">`,
    );
    if (release.title && release.title !== release.version) {
      lines.push(`### ${release.title}`);
      lines.push("");
    }
    if (release.summary) {
      lines.push(release.summary);
    }
    lines.push("</Release>");
    lines.push("");
  }
}

export function orgToMarkdown(org: FormatOrgDetail, opts: OrgMarkdownOptions = {}): string {
  const lines: string[] = [];

  // ── Frontmatter ──
  lines.push("---");
  lines.push(yamlLine("name", org.name));
  lines.push(yamlLine("slug", org.slug));
  if (org.domain) {
    lines.push(yamlLine("domain", org.domain));
  }
  if (org.description) {
    lines.push(yamlLine("description", org.description));
  }
  if (org.category) {
    lines.push(yamlLine("category", org.category));
  }
  lines.push(yamlLine("sources", org.sourceCount));
  lines.push(yamlLine("total_releases", org.releaseCount));
  lines.push(yamlLine("releases_last_30d", org.releasesLast30Days));
  lines.push(yamlLine("avg_releases_per_week", org.avgReleasesPerWeek));
  if (org.lastFetchedAt) {
    lines.push(yamlLine("last_updated", isoDateOnly(org.lastFetchedAt)));
  }
  lines.push(yamlLine("tracking_since", isoDateOnly(org.trackingSince)));

  if (opts.baseUrl) {
    lines.push(yamlLine("canonical", `${opts.baseUrl}/${org.slug}`));
    if (org.overview) {
      lines.push(yamlLine("overview_url", `${opts.baseUrl}/${org.slug}/overview.md`));
    }
  }

  if (org.tags && org.tags.length > 0) {
    lines.push("tags:");
    for (const tag of org.tags) {
      lines.push(`  - ${tag}`);
    }
  }

  if (org.aliases && org.aliases.length > 0) {
    lines.push("aliases:");
    for (const alias of org.aliases) {
      lines.push(`  - ${alias}`);
    }
  }

  if (org.accounts.length > 0) {
    const byPlatform = new Map<string, string[]>();
    for (const acct of org.accounts) {
      const list = byPlatform.get(acct.platform);
      if (list) list.push(acct.handle);
      else byPlatform.set(acct.platform, [acct.handle]);
    }
    lines.push("accounts:");
    for (const [platform, handles] of byPlatform) {
      if (handles.length === 1) {
        lines.push(`  ${platform}: ${yamlScalar(handles[0]!)}`);
      } else {
        lines.push(`  ${platform}:`);
        for (const h of handles) lines.push(`    - ${yamlScalar(h)}`);
      }
    }
  }

  lines.push("---");
  lines.push("");

  // ── Overview ──
  if (org.overview) {
    lines.push("## Overview");
    lines.push("");
    lines.push(org.overview.content);
    lines.push("");
  }

  // ── Products ──
  if (org.products.length > 0) {
    for (const product of org.products) {
      const canonical = opts.baseUrl ? `${opts.baseUrl}/${org.slug}/${product.slug}` : null;
      lines.push(
        `<Product${attr("name", product.name)}${attr("slug", product.slug)}${attr("sources", product.sourceCount)}${product.url ? attr("url", product.url) : ""}${attr("canonical", canonical)} />`,
      );
    }
    lines.push("");
  }

  // ── Sources ──
  for (const source of org.sources) {
    const sourceUrl = opts.baseUrl ? ` url="${opts.baseUrl}/${org.slug}/${source.slug}"` : "";
    lines.push(
      `<Source${attr("name", source.name)}${attr("slug", source.slug)}${attr("type", source.type)}${attr("releases", source.releaseCount)}${attr("latest-version", source.latestVersion)}${attr("latest-date", source.latestDate)}${source.isPrimary ? ' primary="true"' : ""}${sourceUrl} />`,
    );
  }
  lines.push("");

  // ── Recent Releases (cross-source preview) ──
  pushRecentReleasesSection(lines, opts.recentReleases ?? [], opts);

  // ── Fetch-more guidance ──
  if (org.sources.length > 0) {
    lines.push("## Fetching more");
    lines.push("");
    lines.push(
      "Append `.md` (markdown), `.json` (raw data), or `.atom` (feed) to any URL on this page.",
    );
    if (opts.baseUrl) {
      lines.push("");
      lines.push(`- Per-source history: \`${opts.baseUrl}/${org.slug}/{source-slug}\``);
      lines.push(`- Atom feed: \`${opts.baseUrl}/${org.slug}.atom\``);
      lines.push(`- Individual release: \`${opts.baseUrl}/release/{release-id}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Release Detail → Markdown ──────────────────────────────────────

export function releaseToMarkdown(release: ReleaseDetail, opts: FormatOptions = {}): string {
  const lines: string[] = [];

  const orgPath = release.org ? `/${release.org.slug}` : "";
  const sourcePath = orgPath ? `${orgPath}/${release.sourceSlug}` : `/source/${release.sourceSlug}`;

  lines.push("---");
  lines.push(yamlLine("title", release.title));
  if (release.version) lines.push(yamlLine("version", release.version));
  lines.push(yamlLine("source", release.sourceName));
  lines.push(yamlLine("source_slug", release.sourceSlug));
  lines.push(yamlLine("source_type", release.sourceType));
  if (release.org) {
    lines.push(yamlLine("organization", release.org.name));
    lines.push(yamlLine("organization_slug", release.org.slug));
  }
  if (release.publishedAt) {
    lines.push(yamlLine("published", isoDateOnly(release.publishedAt)));
  }
  if (release.url) lines.push(yamlLine("url", release.url));
  if (opts.baseUrl) {
    lines.push(yamlLine("canonical_source", `${opts.baseUrl}${sourcePath}`));
  }
  lines.push("---");
  lines.push("");

  if (release.title) {
    lines.push(`# ${release.title}`);
    lines.push("");
  }

  if (release.content) {
    lines.push(release.content);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Product → Markdown ─────────────────────────────────────────────

export interface ProductMarkdownOptions extends FormatOptions {
  /** Most recent releases across the product's sources, rendered as a preview. */
  recentReleases?: OrgReleaseItem[];
}

export function productToMarkdown(
  product: ProductDetail,
  orgSlug: string,
  opts: ProductMarkdownOptions = {},
): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(yamlLine("name", product.name));
  lines.push(yamlLine("slug", product.slug));
  lines.push(yamlLine("organization_slug", orgSlug));
  if (product.url) lines.push(yamlLine("url", product.url));
  if (product.category) lines.push(yamlLine("category", product.category));
  lines.push(yamlLine("source_count", product.sources.length));
  if (opts.baseUrl) {
    lines.push(yamlLine("canonical", `${opts.baseUrl}/${orgSlug}/${product.slug}`));
  }
  lines.push("---");
  lines.push("");

  lines.push(`# ${product.name}`);
  lines.push("");
  if (product.description) {
    lines.push(product.description);
    lines.push("");
  }

  lines.push(`## Sources (${product.sources.length})`);
  lines.push("");
  if (product.sources.length === 0) {
    lines.push("_No sources yet._");
  } else {
    for (const source of product.sources) {
      const url = opts.baseUrl
        ? `${opts.baseUrl}/${orgSlug}/${source.slug}`
        : `/${orgSlug}/${source.slug}`;
      lines.push(`- [${source.name}](${url}) — \`${source.type}\``);
    }
  }
  lines.push("");

  // ── Recent Releases (cross-source preview) ──
  pushRecentReleasesSection(lines, opts.recentReleases ?? [], opts);

  if (product.tags.length > 0) {
    lines.push(`**Tags:** ${product.tags.map((t) => `\`${t}\``).join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Release Feed → Markdown (shared helpers) ───────────────────────

function pushReleaseBlock(
  lines: string[],
  release: OrgReleaseItem | CollectionReleaseItem,
  extraAttrs: string,
): void {
  const dateStr = formatIsoDate(release.publishedAt);
  lines.push(
    `<Release${attr("version", release.version)}${attr("date", dateStr)}${attr("published", release.publishedAt)}${attr("url", release.url)}${extraAttrs}>`,
  );

  if (release.title && release.title !== release.version) {
    lines.push(`## ${release.title}`);
    lines.push("");
  }

  const body = release.content || release.summary;
  if (body) {
    lines.push(body);
  }

  lines.push("</Release>");
  lines.push("");
}

function pushPaginationFooter(
  lines: string[],
  pagination: { nextCursor: string | null; limit: number },
  feedUrl: string | null,
): void {
  if (!pagination.nextCursor) return;
  const cursorAttrs = [`cursor="${pagination.nextCursor}"`];
  if (feedUrl) {
    cursorAttrs.push(
      `next="${feedUrl}?cursor=${encodeURIComponent(pagination.nextCursor)}&limit=${pagination.limit}"`,
    );
  }
  lines.push(`<Pagination ${cursorAttrs.join(" ")} />`);
  lines.push("");
}

// ── Org Release Feed → Markdown ────────────────────────────────────

export function orgReleaseFeedToMarkdown(
  orgSlug: string,
  releases: OrgReleaseItem[],
  pagination: { nextCursor: string | null; limit: number },
  opts: FormatOptions = {},
): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(yamlLine("organization", orgSlug));
  lines.push(yamlLine("release_count", releases.length));
  if (pagination.nextCursor) {
    lines.push(yamlLine("has_more", "true"));
  }
  if (opts.baseUrl) {
    lines.push(yamlLine("canonical", `${opts.baseUrl}/${orgSlug}`));
  }
  lines.push("---");
  lines.push("");

  for (const release of releases) {
    pushReleaseBlock(lines, release, attr("source", release.source.slug));
  }

  pushPaginationFooter(
    lines,
    pagination,
    opts.baseUrl ? `${opts.baseUrl}/${orgSlug}/releases` : null,
  );

  return lines.join("\n");
}

// ── Collection → Markdown ──────────────────────────────────────────

export function collectionToMarkdown(
  collection: CollectionDetail,
  opts: FormatOptions = {},
): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(yamlLine("name", collection.name));
  lines.push(yamlLine("slug", collection.slug));
  if (collection.description) {
    lines.push(yamlLine("description", collection.description));
  }
  lines.push(yamlLine("member_count", collection.members.length));
  if (opts.baseUrl) {
    lines.push(yamlLine("canonical", `${opts.baseUrl}/collections/${collection.slug}`));
  }
  lines.push("---");
  lines.push("");

  lines.push(`# ${collection.name}`);
  lines.push("");
  if (collection.description) {
    lines.push(collection.description);
    lines.push("");
  }

  lines.push(`## Members (${collection.members.length})`);
  lines.push("");
  if (collection.members.length === 0) {
    lines.push("_No members yet._");
  } else {
    for (const member of collection.members) {
      if (member.kind === "org") {
        const url = opts.baseUrl ? `${opts.baseUrl}/${member.slug}` : `/${member.slug}`;
        const tail = member.domain ? ` — ${member.domain}` : "";
        lines.push(`- [${member.name}](${url})${tail}`);
      } else {
        const url = opts.baseUrl
          ? `${opts.baseUrl}/${member.org.slug}/${member.slug}`
          : `/${member.org.slug}/${member.slug}`;
        lines.push(`- [${member.name}](${url}) (product · ${member.org.name})`);
      }
    }
  }
  lines.push("");

  if (opts.baseUrl) {
    lines.push("## Fetching more");
    lines.push("");
    lines.push(
      "Append `.md` (markdown), `.json` (raw data), or `.atom` (feed) to any URL on this page.",
    );
    lines.push("");
    lines.push(
      `- Aggregated release feed: \`${opts.baseUrl}/collections/${collection.slug}.atom\``,
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ── Aggregated Release Feed → Markdown ────────────────────────────

function aggregateReleaseFeedToMarkdown(
  scope: "collection" | "category",
  slug: string,
  name: string,
  releases: CollectionReleaseItem[],
  pagination: { nextCursor: string | null; limit: number },
  opts: FormatOptions = {},
): string {
  const lines: string[] = [];
  const basePath = scope === "collection" ? "collections" : "categories";
  const nameKey = scope === "collection" ? "collection_name" : "category_name";

  lines.push("---");
  lines.push(yamlLine(scope, slug));
  lines.push(yamlLine(nameKey, name));
  lines.push(yamlLine("release_count", releases.length));
  if (pagination.nextCursor) {
    lines.push(yamlLine("has_more", "true"));
  }
  if (opts.baseUrl) {
    lines.push(yamlLine("canonical", `${opts.baseUrl}/${basePath}/${slug}`));
  }
  lines.push("---");
  lines.push("");

  for (const release of releases) {
    pushReleaseBlock(
      lines,
      release,
      `${attr("org", release.org.slug)}${attr("source", release.source.slug)}`,
    );
  }

  pushPaginationFooter(
    lines,
    pagination,
    opts.baseUrl ? `${opts.baseUrl}/${basePath}/${slug}/releases` : null,
  );

  return lines.join("\n");
}

export function collectionReleaseFeedToMarkdown(
  slug: string,
  name: string,
  releases: CollectionReleaseItem[],
  pagination: { nextCursor: string | null; limit: number },
  opts: FormatOptions = {},
): string {
  return aggregateReleaseFeedToMarkdown("collection", slug, name, releases, pagination, opts);
}

export function categoryReleaseFeedToMarkdown(
  slug: string,
  name: string,
  releases: CollectionReleaseItem[],
  pagination: { nextCursor: string | null; limit: number },
  opts: FormatOptions = {},
): string {
  return aggregateReleaseFeedToMarkdown("category", slug, name, releases, pagination, opts);
}

// ── Search Results → Markdown ──────────────────────────────────────

export function searchToMarkdown(results: UnifiedSearchResponse, opts: FormatOptions = {}): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(yamlLine("query", results.query));
  lines.push("---");
  lines.push("");

  if (results.orgs.length > 0) {
    lines.push("## Organizations");
    lines.push("");
    for (const org of results.orgs) {
      const url = opts.baseUrl ? ` — [view](${opts.baseUrl}/${org.slug})` : "";
      lines.push(
        `- **${org.name}** (\`${org.slug}\`)${org.category ? ` [${org.category}]` : ""}${url}`,
      );
    }
    lines.push("");
  }

  if (results.catalog.length > 0) {
    lines.push("## Products");
    lines.push("");
    for (const p of results.catalog) {
      const orgInfo = p.orgSlug ? ` (${p.orgName})` : "";
      const viewSlug = p.entryType === "source" && p.sourceSlug ? p.sourceSlug : p.slug;
      const url =
        opts.baseUrl && p.orgSlug ? ` — [view](${opts.baseUrl}/${p.orgSlug}/${viewSlug})` : "";
      lines.push(
        `- **${p.name}** (\`${p.slug}\`)${orgInfo}${p.category ? ` [${p.category}]` : ""}${url}`,
      );
    }
    lines.push("");
  }

  if (results.releases.length > 0) {
    lines.push("## Releases");
    lines.push("");
    for (const r of results.releases) {
      const date = r.publishedAt ? ` (${isoDateOnly(r.publishedAt)})` : "";
      const version = r.version ? ` ${r.version}` : "";
      lines.push(`- **${r.sourceName}${version}**${date}: ${r.title}`);
      if (r.summary) {
        lines.push(`  > ${r.summary}`);
      }
    }
    lines.push("");
  }

  if (results.collections && results.collections.length > 0) {
    lines.push("## Collections");
    lines.push("");
    for (const c of results.collections) {
      const url = opts.baseUrl ? ` — [view](${opts.baseUrl}/collections/${c.slug})` : "";
      const count = c.memberCount === 1 ? "1 member" : `${c.memberCount} members`;
      const viaHint =
        c.via === "member" && c.matchedOrgSlugs && c.matchedOrgSlugs.length > 0
          ? ` — includes ${c.matchedOrgSlugs.join(", ")}`
          : "";
      lines.push(`- **${c.name}** (\`${c.slug}\`) — ${count}${viaHint}${url}`);
      if (c.description) {
        lines.push(`  > ${c.description}`);
      }
    }
    lines.push("");
  }

  const collectionsLen = results.collections?.length ?? 0;
  if (
    results.orgs.length === 0 &&
    results.catalog.length === 0 &&
    results.releases.length === 0 &&
    collectionsLen === 0
  ) {
    lines.push("No results found.");
    lines.push("");
  }

  return lines.join("\n");
}

// ── Overview Page → Markdown ──────────────────────────────────────

export function overviewToMarkdown(
  overview: OverviewPageItem,
  opts: FormatOptions & { orgSlug?: string; productSlug?: string } = {},
): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(yamlLine("scope", overview.scope));
  if (opts.orgSlug) {
    lines.push(yamlLine("organization", opts.orgSlug));
  }
  if (opts.productSlug) {
    lines.push(yamlLine("product", opts.productSlug));
  }
  lines.push(yamlLine("release_count", overview.releaseCount));
  if (overview.lastContributingReleaseAt) {
    lines.push(yamlLine("last_release", isoDateOnly(overview.lastContributingReleaseAt)));
  }
  lines.push(yamlLine("generated", isoDateOnly(overview.generatedAt)));
  if (opts.baseUrl && opts.orgSlug) {
    lines.push(yamlLine("canonical", `${opts.baseUrl}/${opts.orgSlug}/overview.md`));
  }
  lines.push("---");
  lines.push("");
  lines.push(overview.content);
  lines.push("");

  return lines.join("\n");
}

/** @deprecated Use overviewToMarkdown */
export const knowledgeToMarkdown = overviewToMarkdown;
