/**
 * Parse a changelog's before/after markdown into the `/releases/batch` body.
 *
 * Two heading styles, tried in order:
 *   1. Versioned `##` headings via `@buildinternet/releases-core/changelog-parse`
 *      (Keep a Changelog, conventional-changelog, `## v1.2.0`).
 *   2. Date-sectioned `## Month D, YYYY` headings — the self-published
 *      CHANGELOG.md format used by this repo (`scripts/changelog/changelog-md.ts`).
 *
 * Diff is keyed on version or date so a re-run of the same commit POSTs the
 * same URLs; `mode: "upsert-content"` then no-ops when the body is unchanged.
 */
import { parseChangelog as parseVersioned } from "../../../packages/core/src/changelog-parse";
import {
  parseChangelog as parseDated,
  type ChangelogSection,
} from "../../../scripts/changelog/changelog-md";

export type IngestFormat =
  | "keep-a-changelog"
  | "conventional"
  | "plain"
  | "date-sectioned"
  | "unknown";

export type PlannedRelease = {
  key: string;
  title: string;
  content: string;
  url: string;
  publishedAt: string | null;
  version?: string | null;
  type: "feature" | "rollup";
  prerelease?: boolean;
};

export type IngestPlan = {
  format: IngestFormat;
  added: string[];
  modified: string[];
  releases: PlannedRelease[];
};

export type PlanUrlVars = {
  key: string;
  version: string;
  date: string;
  path: string;
};

export type PlanOptions = {
  /** `{key}`, `{version}`, `{date}`, `{path}` are interpolated. */
  urlTemplate: string;
  changelogPath?: string;
};

type Section = {
  key: string;
  title: string;
  content: string;
  url: string | null;
  publishedAt: string | null;
  version: string | null;
  type: "feature" | "rollup";
  prerelease: boolean;
};

function dateOnlyToIso(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T12:00:00Z`;
  return value;
}

function datedToSection(s: ChangelogSection): Section {
  return {
    key: s.dateIso,
    title: s.title,
    content: s.body,
    url: null,
    publishedAt: `${s.dateIso}T12:00:00Z`,
    version: null,
    type: "rollup",
    prerelease: false,
  };
}

function parseSections(markdown: string): { format: IngestFormat; sections: Section[] } {
  const versioned = parseVersioned(markdown);
  if (versioned.parsable) {
    return {
      format: versioned.format,
      sections: versioned.releases.map((r) => ({
        key: r.version ?? r.title,
        title: r.title,
        content: r.content,
        url: r.url,
        publishedAt: dateOnlyToIso(r.publishedAt),
        version: r.version,
        type: "feature",
        prerelease: r.prerelease,
      })),
    };
  }

  const dated = parseDated(markdown);
  if (dated.length > 0) {
    return { format: "date-sectioned", sections: dated.map(datedToSection) };
  }

  return { format: "unknown", sections: [] };
}

export function renderUrlTemplate(template: string, vars: PlanUrlVars): string {
  return template.replace(/\{(key|version|date|path)\}/g, (_, name: keyof PlanUrlVars) => {
    return vars[name] ?? "";
  });
}

export function releaseUrl(section: Section, opts: PlanOptions): string {
  if (section.url) return section.url;
  const date = (section.publishedAt ?? "").slice(0, 10);
  return renderUrlTemplate(opts.urlTemplate, {
    key: section.key,
    version: section.version ?? "",
    date,
    path: opts.changelogPath ?? "CHANGELOG.md",
  });
}

export function toBatchBody(releases: PlannedRelease[]): Omit<PlannedRelease, "key">[] {
  return releases.map((r) => ({
    title: r.title,
    content: r.content,
    url: r.url,
    publishedAt: r.publishedAt,
    version: r.version,
    type: r.type,
    prerelease: r.prerelease,
  }));
}

export function sectionToBatchRelease(section: Section, opts: PlanOptions): PlannedRelease {
  const url = releaseUrl(section, opts);
  if (!url) {
    throw new Error(
      `No URL for changelog section "${section.key}" — set url-template or use headings with links.`,
    );
  }
  return {
    key: section.key,
    title: section.title,
    content: section.content,
    url,
    publishedAt: section.publishedAt,
    version: section.version,
    type: section.type,
    prerelease: section.prerelease,
  };
}

/**
 * Diff two changelog snapshots and map the changed sections to batch rows.
 * Unchanged sections are omitted so a no-op push does not touch the API.
 */
export function planChangelogIngest(
  beforeMd: string,
  afterMd: string,
  opts: PlanOptions,
): IngestPlan {
  const after = parseSections(afterMd);
  if (after.format === "unknown") {
    return { format: "unknown", added: [], modified: [], releases: [] };
  }

  const before = parseSections(beforeMd);
  const beforeByKey = new Map(before.sections.map((s) => [s.key, s.content]));
  const added: string[] = [];
  const modified: string[] = [];
  const changed: Section[] = [];

  for (const section of after.sections) {
    if (!beforeByKey.has(section.key)) {
      added.push(section.key);
      changed.push(section);
    } else if (beforeByKey.get(section.key) !== section.content) {
      modified.push(section.key);
      changed.push(section);
    }
  }

  return {
    format: after.format,
    added,
    modified,
    releases: changed.map((section) => sectionToBatchRelease(section, opts)),
  };
}

/** True when the after snapshot has content but no recognized headings. */
export function isUnparsableChangelog(afterMd: string): boolean {
  if (afterMd.trim().length === 0) return false;
  return parseSections(afterMd).format === "unknown";
}
