/**
 * Plan a changelog push into the `POST /v1/sources/…/releases/batch` body
 * (`mode: "upsert-content"`). Shared by `actions/publish-changelog` and the
 * `releases publish` CLI so the two cannot drift.
 *
 * Single-file mode (`planChangelogIngest`) tries two heading styles:
 *   1. Versioned `##` headings via `changelog-parse` (Keep a Changelog,
 *      conventional-changelog, `## v1.2.0`).
 *   2. Date-sectioned `## Month D, YYYY` headings.
 *
 * Directory mode (`planDirectoryIngest`) is one MDX/Markdown file per entry,
 * metadata in YAML frontmatter. `draft: true` skips a file.
 *
 * Since-SHA diffing is an input, not I/O. The caller resolves `before-sha` /
 * `--since` (see `isMissingOrZeroSha`):
 *   - single-file: pass the markdown at that SHA as `beforeMd`, or `""` when
 *     the SHA is missing, all-zero, or the file is new — every section is added.
 *   - directory: pass `git diff --name-status` rows (added / modified / deleted)
 *     already filtered to the glob. When the SHA is missing, pass every
 *     matching file as status `"A"`.
 *
 * `toBatchRequest` is the dry-run / POST body. Re-planning the same snapshot
 * yields the same URLs; `upsert-content` then no-ops when the body is unchanged.
 */
import { parseChangelog as parseVersioned } from "./changelog-parse.js";
import { parseDatedChangelog, type ChangelogSection } from "./changelog-dated.js";
import {
  extractTitleHeading,
  flattenMdxToMarkdown,
  parseFrontmatter,
} from "./changelog-publish-mdx.js";

export {
  extractTitleHeading,
  flattenMdxToMarkdown,
  parseFrontmatter,
  type Frontmatter,
  type ParsedMdx,
} from "./changelog-publish-mdx.js";

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
  /** `{key}`, `{version}`, `{date}`, `{path}`, `{slug}` are interpolated. */
  urlTemplate: string;
  changelogPath?: string;
};

/** Wire `mode` for a publish batch. The only mode the batch route treats as an overwrite. */
export const UPSERT_CONTENT_MODE = "upsert-content" as const;

/** One release object inside the batch body (`key` is planner-local, not posted). */
export type BatchReleaseBody = Omit<PlannedRelease, "key">;

/** Body of `POST /v1/sources/…/releases/batch` for a publish. */
export type BatchUpsertRequest = {
  mode: typeof UPSERT_CONTENT_MODE;
  releases: BatchReleaseBody[];
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

/** True when a since/before SHA is absent or GitHub's all-zero first-push SHA. */
export function isMissingOrZeroSha(sha: string | null | undefined): boolean {
  return !sha || /^0+$/.test(sha);
}

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

  const dated = parseDatedChangelog(markdown);
  if (dated.length > 0) {
    return { format: "date-sectioned", sections: dated.map(datedToSection) };
  }

  return { format: "unknown", sections: [] };
}

/** `{slug}` is an alias for `{key}` — directory mode's key is the entry's slug. */
export function renderUrlTemplate(template: string, vars: PlanUrlVars): string {
  return template.replace(/\{(key|version|date|path|slug)\}/g, (_, name: string) =>
    name === "slug" ? vars.key : vars[name as keyof PlanUrlVars],
  );
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

export function toBatchBody(releases: PlannedRelease[]): BatchReleaseBody[] {
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

/** Dry-run plan and the JSON body posted to `/releases/batch`. */
export function toBatchRequest(releases: PlannedRelease[]): BatchUpsertRequest {
  return { mode: UPSERT_CONTENT_MODE, releases: toBatchBody(releases) };
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
 * `beforeMd` is the file at `before-sha` / `--since` (`""` publishes every
 * section). Unchanged sections are omitted so a no-op push does not touch the API.
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

// ---------------------------------------------------------------------------
// Directory mode: one MDX/Markdown file per release, frontmatter metadata.
// ---------------------------------------------------------------------------

export type DirectoryFileStatus = "A" | "M" | "D";

export type DirectoryFileInput = {
  /** Path relative to the resolved working-directory (matches `changelog-glob`). */
  path: string;
  status: DirectoryFileStatus;
  /** Raw file content. Required unless `status` is `"D"`. */
  content?: string;
};

export type DirectoryIngestPlan = {
  added: string[];
  modified: string[];
  deleted: string[];
  releases: PlannedRelease[];
};

export type DirectoryPlanOptions = {
  /** `{key}`, `{slug}`, `{version}`, `{date}`, `{path}` are interpolated. */
  urlTemplate: string;
  /** The `changelog-glob` pattern, used to derive the static base dir for keys. */
  glob: string;
};

/** The static (non-wildcard) prefix directory of a glob, e.g. `changelog/**\/*.mdx` → `changelog/`. */
export function globBaseDir(glob: string): string {
  const idx = glob.search(/[*?{[]/);
  if (idx === -1) return "";
  const prefix = glob.slice(0, idx);
  const lastSlash = prefix.lastIndexOf("/");
  return lastSlash === -1 ? "" : prefix.slice(0, lastSlash + 1);
}

/** File path, relative to the glob's static base dir, without its extension. */
export function keyFromPath(path: string, baseDir: string): string {
  const rel = baseDir && path.startsWith(baseDir) ? path.slice(baseDir.length) : path;
  return rel.replace(/\.[^./]+$/, "");
}

function basenameNoExt(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.[^./]+$/, "");
}

function firstStringField(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** Normalizes a frontmatter date value (string, or a YAML-parsed `Date`) to ISO, or null. */
function normalizeFrontmatterDate(data: Record<string, unknown>): string | null {
  const keys = ["date", "publishedAt", "published", "pubDate"];
  for (const key of keys) {
    const value = data[key];
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString();
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const iso = dateOnlyToIso(value.trim());
      if (iso && !Number.isNaN(Date.parse(iso))) return iso;
      return null;
    }
  }
  return null;
}

function frontmatterVersion(data: Record<string, unknown>): string | null {
  const value = data.version;
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() || null;
  return String(value);
}

/**
 * Plans directory-mode releases: one entry per added/modified MDX/Markdown
 * file. `files` are the since-SHA name-status rows (or every file as `"A"`
 * on a first push). Deleted files are reported (not upserted or removed from
 * the index). Draft files (`draft: true` in frontmatter) are skipped entirely.
 * Pure — takes file contents already read by the caller, no I/O.
 */
export function planDirectoryIngest(
  files: DirectoryFileInput[],
  opts: DirectoryPlanOptions,
): DirectoryIngestPlan {
  const baseDir = globBaseDir(opts.glob);
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const releases: PlannedRelease[] = [];

  for (const file of files) {
    if (file.status === "D") {
      deleted.push(file.path);
      continue;
    }

    const { data, body } = parseFrontmatter(file.content ?? "");
    if (data.draft === true) continue;

    const slug = firstStringField(data, ["slug"]);
    const key = slug || keyFromPath(file.path, baseDir);
    const title =
      firstStringField(data, ["title"]) || extractTitleHeading(body) || basenameNoExt(file.path);
    const publishedAt = normalizeFrontmatterDate(data);
    const version = frontmatterVersion(data);
    const explicitUrl = firstStringField(data, ["url", "canonical"]);
    const content = flattenMdxToMarkdown(body);

    const url =
      explicitUrl ||
      renderUrlTemplate(opts.urlTemplate, {
        key,
        version: version ?? "",
        date: (publishedAt ?? "").slice(0, 10),
        path: file.path,
      });

    if (!url) {
      throw new Error(
        `No URL for "${file.path}" — set url-template, or add a frontmatter url/canonical.`,
      );
    }

    releases.push({
      key,
      title,
      content,
      url,
      publishedAt,
      version,
      type: "feature",
      prerelease: false,
    });

    if (file.status === "A") added.push(key);
    else modified.push(key);
  }

  return { added, modified, deleted, releases };
}
