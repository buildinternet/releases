import type { OrgListItem } from "@/lib/api";

export interface OrgLetterGroup {
  /** "A".."Z", or "#" for names that don't start with a Latin letter. */
  letter: string;
  /** Orgs in this bucket, sorted case-insensitively by name. */
  orgs: OrgListItem[];
}

const ALPHA: readonly string[] = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

/**
 * Jump-strip order for the catalog: A–Z then "#". Drives both the sticky
 * letter nav (dimming letters with no orgs) and the section ordering returned
 * by {@link groupOrgsByLetter}.
 */
export const CATALOG_LETTERS: readonly string[] = [...ALPHA, "#"];

/** Bucket key for an org name: its uppercased first letter, or "#". */
function letterFor(name: string): string {
  const first = name.trim().charAt(0).toUpperCase();
  return first >= "A" && first <= "Z" ? first : "#";
}

/**
 * Group orgs into alphabetical sections for the A-to-Z catalog. Sections are
 * returned in {@link CATALOG_LETTERS} order with empty letters omitted; within
 * each section orgs are sorted case-insensitively by name (matching the home
 * `OrgTable` name sort).
 */
export function groupOrgsByLetter(orgs: OrgListItem[]): OrgLetterGroup[] {
  const buckets = new Map<string, OrgListItem[]>();
  for (const org of orgs) {
    const letter = letterFor(org.name);
    const bucket = buckets.get(letter);
    if (bucket) bucket.push(org);
    else buckets.set(letter, [org]);
  }

  const groups: OrgLetterGroup[] = [];
  for (const letter of CATALOG_LETTERS) {
    const bucket = buckets.get(letter);
    if (!bucket || bucket.length === 0) continue;
    bucket.sort((a, b) => {
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    groups.push({ letter, orgs: bucket });
  }
  return groups;
}
