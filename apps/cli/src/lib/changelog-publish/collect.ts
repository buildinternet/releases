/**
 * Read a changelog (single file or directory glob) and build the batch body
 * `releases publish` POSTs. Parsing lives in
 * `@buildinternet/releases-core/changelog-publish`, shared with the
 * publish-changelog GitHub Action.
 */
import {
  isUnparsableChangelog,
  planChangelogIngest,
  planDirectoryIngest,
  toBatchRequest,
  type BatchReleaseBody,
  type DirectoryFileInput,
  type IngestFormat,
  type PlannedRelease,
} from "@buildinternet/releases-core/changelog-publish";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CliError } from "../errors.js";
import { assertGitCommit, gitDiffNameStatus, gitShowFile, isMissingOrZeroSha } from "./git.js";

const DEFAULT_CHANGELOG_PATH = "CHANGELOG.md";

export type BatchRelease = BatchReleaseBody;

export type CollectInput = {
  changelogPath?: string;
  glob?: string;
  /** Action `working-directory`. Relative paths resolve from `process.cwd()`. */
  workingDirectory?: string;
  /** Action `before-sha`. Omitted, blank, or all-zero → publish every entry. */
  beforeSha?: string;
  urlTemplate?: string;
  githubRepository?: string;
  githubRefName?: string;
  warn?: (message: string) => void;
};

export type CollectedPlan = {
  /** `null` in directory mode — that mode has no heading format. */
  format: IngestFormat | null;
  added: string[];
  modified: string[];
  deleted: string[];
  releases: PlannedRelease[];
  body: {
    mode: "upsert-content";
    releases: BatchRelease[];
  };
};

function asCliError(err: unknown): never {
  if (err instanceof CliError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  throw new CliError(message.replaceAll("url-template", "--url-template"));
}

function defaultUrlTemplate(input: CollectInput, blobPath: string): string {
  const repo = input.githubRepository?.trim();
  const ref = input.githubRefName?.trim() || "main";
  if (repo) return `https://github.com/${repo}/blob/${ref}/${blobPath}`;
  throw new CliError(
    "Pass --url-template (placeholders {key}, {version}, {date}, {path}, {slug}). It is required when GITHUB_REPOSITORY is unset.",
  );
}

function readUtf8(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new CliError(`Changelog file not found: ${path}`);
    throw err;
  }
}

/**
 * Gathers directory-mode changed files. On first push / a new branch
 * (`before` missing or all-zero) every file matching the glob is treated as
 * added — mirroring single-file mode publishing everything when there is no
 * previous snapshot to diff against.
 */
async function gatherDirectoryFiles(
  input: CollectInput,
  workdir: string | undefined,
  glob: string,
): Promise<DirectoryFileInput[]> {
  const cwd = workdir ? resolve(workdir) : process.cwd();
  const bunGlob = new Bun.Glob(glob);
  const files: DirectoryFileInput[] = [];

  const entries = gitDiffNameStatus(input.beforeSha, workdir ? cwd : undefined);
  if (entries === null) {
    if (!isMissingOrZeroSha(input.beforeSha)) {
      input.warn?.(
        `git diff against ${input.beforeSha} failed (shallow clone or rewritten history?); publishing every file matching ${glob}.`,
      );
    }
    for await (const relPath of bunGlob.scan({ cwd, onlyFiles: true, dot: false })) {
      const content = readFileSync(resolve(cwd, relPath), "utf8");
      files.push({ path: relPath, status: "A", content });
    }
    return files;
  }

  for (const entry of entries) {
    if (!bunGlob.match(entry.path)) continue;
    if (entry.status === "D") {
      files.push({ path: entry.path, status: "D" });
      continue;
    }
    try {
      const content = readFileSync(resolve(cwd, entry.path), "utf8");
      files.push({ path: entry.path, status: entry.status, content });
    } catch {
      // File listed by the diff but no longer on disk — skip defensively.
    }
  }
  return files;
}

function finish(plan: {
  format: IngestFormat | null;
  added: string[];
  modified: string[];
  deleted: string[];
  releases: PlannedRelease[];
}): CollectedPlan {
  return {
    format: plan.format,
    added: plan.added,
    modified: plan.modified,
    deleted: plan.deleted,
    releases: plan.releases,
    body: toBatchRequest(plan.releases),
  };
}

async function collectSingleFile(
  input: CollectInput,
  workdir: string | undefined,
  changelogPath: string,
): Promise<CollectedPlan> {
  const urlTemplate =
    input.urlTemplate?.trim() || defaultUrlTemplate(input, `${changelogPath}#{key}`);
  const filePath = workdir ? resolve(workdir, changelogPath) : resolve(changelogPath);
  const beforeMd = gitShowFile(
    input.beforeSha,
    changelogPath,
    workdir ? resolve(workdir) : undefined,
  );
  const afterMd = readUtf8(filePath);

  if (afterMd !== beforeMd && isUnparsableChangelog(afterMd)) {
    throw new CliError(
      `${changelogPath} changed but no versioned or date-sectioned ## headings were found.`,
    );
  }

  try {
    const plan = planChangelogIngest(beforeMd, afterMd, { urlTemplate, changelogPath });
    return finish({ ...plan, deleted: [] });
  } catch (err) {
    asCliError(err);
  }
}

async function collectDirectory(
  input: CollectInput,
  workdir: string | undefined,
  glob: string,
): Promise<CollectedPlan> {
  const urlTemplate = input.urlTemplate?.trim() || defaultUrlTemplate(input, "{path}");
  const files = await gatherDirectoryFiles(input, workdir, glob);
  try {
    const plan = planDirectoryIngest(files, { urlTemplate, glob });
    return finish({ ...plan, format: null });
  } catch (err) {
    asCliError(err);
  }
}

export async function collectPublishPlan(input: CollectInput): Promise<CollectedPlan> {
  const glob = input.glob?.trim() || undefined;
  const changelogPath = input.changelogPath?.trim() || DEFAULT_CHANGELOG_PATH;
  if (glob && changelogPath !== DEFAULT_CHANGELOG_PATH) {
    throw new CliError(
      "--glob cannot be combined with a non-default --changelog. Set one or the other.",
    );
  }
  const workdir = input.workingDirectory?.trim() || undefined;
  const beforeSha = input.beforeSha?.trim() || undefined;
  if (beforeSha && !isMissingOrZeroSha(beforeSha)) {
    assertGitCommit(beforeSha, workdir ? resolve(workdir) : undefined);
  }
  if (glob) return collectDirectory(input, workdir, glob);
  return collectSingleFile(input, workdir, changelogPath);
}
