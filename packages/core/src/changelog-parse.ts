/**
 * Deterministic changelog → structured releases, in the stored-release shape.
 * Two producers, both pure and runtime-neutral: `parseChangelog` for markdown
 * files and `mapGitHubReleases` for the GitHub Releases API. Used by the
 * experimental `POST /v1/changelog/parse` endpoint (no persistence) and any
 * client (CLI) that wants the same shape without a server round-trip.
 */

import { isPrereleaseVersion } from "./prerelease";

/**
 * A single release entry. Mirrors the parse-relevant subset of the stored
 * release shape (`ReleaseDetailResponseSchema`). AI-only fields are always
 * null and `media` is always empty — deterministic parsing can't produce them.
 */
export interface ParsedChangelogRelease {
  version: string | null;
  /** Deterministic default; the "rollup" type is AI-classified and never emitted here. */
  type: "feature";
  title: string;
  content: string;
  url: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  summary: null;
  titleGenerated: null;
  titleShort: null;
  media: [];
}

export type ChangelogFormat = "keep-a-changelog" | "conventional" | "plain" | "unknown";

export interface ParseChangelogResult {
  /** True when ≥1 version-shaped `##` heading was found. */
  parsable: boolean;
  format: ChangelogFormat;
  releases: ParsedChangelogRelease[];
  /** Total level-2 headings seen (parsed + skipped). */
  headingsScanned: number;
  /** Version-less headings (e.g. `## [Unreleased]`, prose section titles). */
  skipped: number;
}

/** Matches a level-2 heading (`##`, not `###`), capturing the heading text. */
const LEVEL2_HEADING = /^##(?!#)\s+(.+?)\s*$/;

type HeadingStyle = "link" | "bracket" | "plain";

interface ParsedHeading {
  version: string;
  url: string | null;
  publishedAt: string | null;
  style: HeadingStyle;
}

/** Strip a leading `v`, then accept only version-ish tokens (must contain a digit). */
function normalizeVersion(token: string): string | null {
  const v = token.trim().replace(/^v/i, "");
  if (!/\d/.test(v)) return null;
  if (!/^\d[\w.\-+]*$/.test(v)) return null;
  return v;
}

/**
 * Pull a version (+ optional date and link href) out of a `##` heading.
 * Handles `[1.4.0](href) (date)`, `[1.4.0] - date`, `1.4.0 (date)`, `v1.4.0`.
 * Returns null for version-less headings (e.g. `[Unreleased]`).
 */
function parseHeading(headingText: string): ParsedHeading | null {
  let text = headingText.trim();
  let url: string | null = null;
  let style: HeadingStyle = "plain";

  const link = text.match(/^\[([^\]]+)\]\(([^)]+)\)/);
  if (link) {
    style = "link";
    url = link[2];
    text = (link[1].trim() + text.slice(link[0].length)).trim();
  } else {
    const bracket = text.match(/^\[([^\]]+)\]/);
    if (bracket) {
      style = "bracket";
      text = (bracket[1].trim() + text.slice(bracket[0].length)).trim();
    }
  }

  const date = text.match(/(\d{4}-\d{2}-\d{2})/);
  const publishedAt = date ? date[1] : null;

  const firstToken = text.split(/[\s,(]+/)[0] ?? "";
  const version = normalizeVersion(firstToken);
  if (!version) return null;

  return { version, url, publishedAt, style };
}

export function parseChangelog(markdown: string): ParseChangelogResult {
  const lines = markdown.split("\n");

  const headings: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LEVEL2_HEADING);
    if (m) headings.push({ line: i, text: m[1] });
  }

  const releases: ParsedChangelogRelease[] = [];
  let skipped = 0;
  let sawLink = false;
  let sawBracket = false;

  for (let h = 0; h < headings.length; h++) {
    const parsed = parseHeading(headings[h].text);
    if (!parsed) {
      skipped++;
      continue;
    }
    if (parsed.style === "link") sawLink = true;
    else if (parsed.style === "bracket") sawBracket = true;

    const start = headings[h].line + 1;
    const end = h + 1 < headings.length ? headings[h + 1].line : lines.length;
    const content = lines.slice(start, end).join("\n").trim();

    releases.push({
      version: parsed.version,
      type: "feature",
      title: parsed.version,
      content,
      url: parsed.url,
      publishedAt: parsed.publishedAt,
      prerelease: isPrereleaseVersion(parsed.version),
      summary: null,
      titleGenerated: null,
      titleShort: null,
      media: [],
    });
  }

  // conventional (linked headings) > keep-a-changelog (bracketed) > plain.
  const format: ChangelogFormat =
    releases.length === 0
      ? "unknown"
      : sawLink
        ? "conventional"
        : sawBracket
          ? "keep-a-changelog"
          : "plain";

  return {
    parsable: releases.length > 0,
    format,
    releases,
    headingsScanned: headings.length,
    skipped,
  };
}
