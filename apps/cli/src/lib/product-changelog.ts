/**
 * Fetch and format the public releases.sh product changelog for
 * `releases changelog` and the MCP `changelog` tool.
 *
 * The feed is the self-published `releases-sh` org in the registry — the
 * same source the website renders at /updates. No extra website JSON twin
 * is required; the CLI already speaks that API.
 */
import { getLatestReleases } from "../api/releases.js";
import type { LatestRelease } from "../api/types.js";
import { humanDate } from "./release-display.js";

export const CHANGELOG_ORG_SLUG = "releases-sh";
export const CHANGELOG_PAGE_URL = "https://releases.sh/updates";
export const CHANGELOG_FEED_URL = "https://releases.sh/releases-sh.atom";
export const DEFAULT_CHANGELOG_LIMIT = 5;
export const MAX_CHANGELOG_LIMIT = 50;

export type ChangelogKind = "platform" | "cli";

export type ChangelogEntry = {
  id: string;
  kind: ChangelogKind;
  title: string;
  date: string;
  url: string;
  tags: string[];
  summary: string;
  body: string;
};

export type ChangelogDocument = {
  url: string;
  feed: string;
  entries: ChangelogEntry[];
};

export type FetchProductChangelogOptions = {
  limit?: number;
  fetchLatest?: (opts: { org: string; count: number }) => Promise<LatestRelease[]>;
};

/** Platform rollups live on `product-changelog`; everything else is a CLI/package cut. */
export function changelogKindFromSource(sourceSlug: string | null | undefined): ChangelogKind {
  return sourceSlug === "product-changelog" ? "platform" : "cli";
}

export function releasePermalink(id: string): string {
  return `https://releases.sh/release/${id}`;
}

export function toChangelogEntry(row: LatestRelease): ChangelogEntry {
  const summary = row.summary?.trim() ?? "";
  const sourceSlug = row.sourceSlug?.trim() || "";
  return {
    id: row.id,
    kind: changelogKindFromSource(sourceSlug),
    title: row.title,
    date: row.publishedAt ?? "",
    url: releasePermalink(row.id),
    tags: sourceSlug ? [sourceSlug] : [],
    summary,
    body: summary,
  };
}

export function clampChangelogLimit(limit: number | undefined): number {
  const n = limit ?? DEFAULT_CHANGELOG_LIMIT;
  if (n > MAX_CHANGELOG_LIMIT) return MAX_CHANGELOG_LIMIT;
  if (n < 1) return DEFAULT_CHANGELOG_LIMIT;
  return n;
}

function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? prefix.trimEnd() : `${prefix}${line}`))
    .join("\n");
}

/** Human terminal output: recent titles + summaries, then a link to /updates. */
export function formatChangelogHuman(doc: ChangelogDocument): string {
  const lines: string[] = ["What's new", ""];
  if (doc.entries.length === 0) {
    lines.push("No changelog entries.");
  } else {
    for (const entry of doc.entries) {
      lines.push(entry.title);
      const when = humanDate(entry.date) || entry.date || "undated";
      lines.push(`${when}  ·  ${entry.url}`);
      lines.push("");
      if (entry.summary) {
        lines.push(indent(entry.summary));
        lines.push("");
      }
    }
  }
  lines.push(`See all updates: ${doc.url}`);
  return `${lines.join("\n")}\n`;
}

export async function fetchProductChangelog(
  opts: FetchProductChangelogOptions = {},
): Promise<ChangelogDocument> {
  const limit = clampChangelogLimit(opts.limit);
  const fetchLatest = opts.fetchLatest ?? getLatestReleases;
  const releases = await fetchLatest({ org: CHANGELOG_ORG_SLUG, count: limit });
  return {
    url: CHANGELOG_PAGE_URL,
    feed: CHANGELOG_FEED_URL,
    entries: releases.slice(0, limit).map(toChangelogEntry),
  };
}
