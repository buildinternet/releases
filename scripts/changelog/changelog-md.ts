// Pure, runtime-neutral helpers for the self-published CHANGELOG.md format.
// The file is date-sectioned, newest-first:
//   # Changelog
//   <preamble>
//   ## June 10, 2026
//   **Added**
//   - ...
// Each `## <Month D, YYYY>` section maps to one `rollup` release.

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface ChangelogSection {
  dateIso: string; // "2026-06-10"
  title: string; // "June 10, 2026"
  body: string; // "**Added**\n- ..."
}

export function isoToTitle(dateIso: string): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  if (!MONTHS[m - 1] || Number.isNaN(d) || Number.isNaN(y)) {
    throw new Error(`Invalid ISO date: ${dateIso}`);
  }
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function titleToIso(title: string): string | null {
  const m = title.trim().match(/^(\w+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (!m) return null;
  const monthIdx = MONTHS.indexOf(m[1]);
  if (monthIdx < 0) return null;
  const mm = String(monthIdx + 1).padStart(2, "0");
  const dd = String(Number(m[2])).padStart(2, "0");
  return `${m[3]}-${mm}-${dd}`;
}

const HEADING = /^##(?!#)\s+(.+?)\s*$/;

export function parseChangelog(markdown: string): ChangelogSection[] {
  const lines = markdown.split("\n");
  const heads: { line: number; title: string; dateIso: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING);
    if (!m) continue;
    const iso = titleToIso(m[1]);
    if (!iso) continue; // skip non-date level-2 headings
    heads.push({ line: i, title: m[1].trim(), dateIso: iso });
  }
  const out: ChangelogSection[] = [];
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h].line + 1;
    const end = h + 1 < heads.length ? heads[h + 1].line : lines.length;
    out.push({
      dateIso: heads[h].dateIso,
      title: heads[h].title,
      body: lines.slice(start, end).join("\n").trim(),
    });
  }
  return out;
}

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
