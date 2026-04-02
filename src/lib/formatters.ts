/**
 * Shared formatters for producing agent-friendly markdown and JSON output.
 *
 * These work on the API response shapes so they can be used identically by
 * the CLI, MCP server, and web frontend.
 */

import type {
  ReleaseItem,
  ReleaseSummaryItem,
  SourceDetail,
  SourceListItem,
  OrgDetail,
} from "../api/types.js";

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

// ── Source → Markdown ────────────────────────────────────────────────

export function sourceToMarkdown(source: FormatSourceDetail, opts: FormatOptions = {}): string {
  const lines: string[] = [];

  // ── Frontmatter ──
  const sourcePath = source.org
    ? `/${source.org.slug}/${source.slug}`
    : `/source/${source.slug}`;

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
    lines.push(`<Summary type="rolling" window-days="${source.summaries.rolling.windowDays}" release-count="${source.summaries.rolling.releaseCount}">`);
    lines.push(source.summaries.rolling.summary);
    lines.push("</Summary>");
    lines.push("");
  }

  for (const monthly of source.summaries?.monthly ?? []) {
    const monthName = monthly.month != null && monthly.year != null
      ? new Date(monthly.year, monthly.month - 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })
      : "";
    lines.push(`<Summary type="monthly"${attr("period", monthName)}${attr("release-count", monthly.releaseCount)}>`);
    lines.push(monthly.summary);
    lines.push("</Summary>");
    lines.push("");
  }

  // ── Releases ──
  for (const release of source.releases) {
    const dateStr = formatIsoDate(release.publishedAt);
    lines.push(
      `<Release${attr("version", release.version)}${attr("date", dateStr)}${attr("published", release.publishedAt)}${attr("url", release.url)}>`
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
  if (source.pagination.totalPages > 1) {
    const paginationAttrs = [
      `page="${source.pagination.page}"`,
      `total-pages="${source.pagination.totalPages}"`,
      `total-items="${source.pagination.totalItems}"`,
    ];
    if (opts.baseUrl) {
      paginationAttrs.push(`next="${opts.baseUrl}${sourcePath}.md?page=${source.pagination.page + 1}"`);
    }
    lines.push(`<Pagination ${paginationAttrs.join(" ")} />`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Org → Markdown ──────────────────────────────────────────────────

export function orgToMarkdown(org: FormatOrgDetail, opts: FormatOptions = {}): string {
  const lines: string[] = [];

  // ── Frontmatter ──
  lines.push("---");
  lines.push(yamlLine("name", org.name));
  lines.push(yamlLine("slug", org.slug));
  if (org.domain) {
    lines.push(yamlLine("domain", org.domain));
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
  }

  if (org.accounts.length > 0) {
    lines.push("accounts:");
    for (const acct of org.accounts) {
      lines.push(`  - platform: ${acct.platform}`);
      lines.push(`    handle: ${acct.handle}`);
    }
  }

  lines.push("---");
  lines.push("");

  // ── Sources ──
  for (const source of org.sources) {
    const sourceUrl = opts.baseUrl ? ` url="${opts.baseUrl}/${org.slug}/${source.slug}"` : "";
    lines.push(
      `<Source${attr("name", source.name)}${attr("slug", source.slug)}${attr("type", source.type)}${attr("releases", source.releaseCount)}${attr("latest-version", source.latestVersion)}${attr("latest-date", source.latestDate)}${source.isPrimary ? ' primary="true"' : ""}${sourceUrl} />`
    );
  }

  lines.push("");

  return lines.join("\n");
}
