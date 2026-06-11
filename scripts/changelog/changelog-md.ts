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
