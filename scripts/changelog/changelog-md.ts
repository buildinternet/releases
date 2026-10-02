// Helpers for the self-published CHANGELOG.md format. Date-section parsing
// lives in `@buildinternet/releases-core` (changelog-dated) so the publish
// planner and this script share one reader. Rendering stays here: the
// preamble and the releases.sh URL are specific to this repo.

import {
  isoToTitle,
  parseDatedChangelog as parseChangelog,
  titleToIso,
  type ChangelogSection,
} from "../../packages/core/src/changelog-dated";

export { isoToTitle, parseChangelog, titleToIso, type ChangelogSection };

export interface ChangelogReleaseInput {
  dateIso: string;
  body: string;
}

const PREAMBLE = `# Changelog

The product changelog for releases.sh, published to its own registry. Drafted daily from merged
PRs and reviewed via PR. See docs/changelog-style.md for the voice and curation rules.`;

export function renderChangelog(entries: ChangelogReleaseInput[]): string {
  const sorted = [...entries].sort((a, b) => b.dateIso.localeCompare(a.dateIso)); // newest first
  const blocks = sorted.map((e) => `## ${isoToTitle(e.dateIso)}\n\n${e.body.trim()}`);
  return `${PREAMBLE}\n\n${blocks.join("\n\n")}\n`;
}

export interface ChangelogDiff {
  added: string[]; // dateIso present in after, not before
  modified: string[]; // dateIso present in both, body differs
}

export function diffChangelog(beforeMd: string, afterMd: string): ChangelogDiff {
  const before = new Map(parseChangelog(beforeMd).map((s) => [s.dateIso, s.body]));
  const added: string[] = [];
  const modified: string[] = [];
  for (const s of parseChangelog(afterMd)) {
    if (!before.has(s.dateIso)) added.push(s.dateIso);
    else if (before.get(s.dateIso) !== s.body) modified.push(s.dateIso);
  }
  return { added, modified };
}

export interface BatchRelease {
  title: string;
  content: string;
  url: string;
  publishedAt: string;
  type: "rollup";
}

export function sectionToRelease(section: ChangelogSection): BatchRelease {
  return {
    title: section.title,
    content: section.body,
    url: `https://releases.sh/updates/${section.dateIso}`,
    publishedAt: `${section.dateIso}T12:00:00Z`,
    type: "rollup",
  };
}

export interface PublishPlan {
  added: string[];
  modified: string[];
  releases: BatchRelease[]; // added then modified
}

export function planPublish(beforeMd: string, afterMd: string): PublishPlan {
  const { added, modified } = diffChangelog(beforeMd, afterMd);
  const byDate = new Map(parseChangelog(afterMd).map((s) => [s.dateIso, s]));
  const releases = [...added, ...modified].map((d) => sectionToRelease(byDate.get(d)!));
  return { added, modified, releases };
}
