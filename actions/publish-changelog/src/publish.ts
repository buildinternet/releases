#!/usr/bin/env bun
/**
 * Push-changed changelog sections into Releases Index via
 * POST /v1/sources/…/releases/batch (`upsert-content`).
 *
 * Two modes:
 *   - Single-file (default): diffs one changelog file's `##` sections
 *     before/after the push (see plan.ts `planChangelogIngest`).
 *   - Directory (when `changelog-glob` is set): diffs the files matching
 *     the glob via `git diff --name-status` and plans one release per
 *     added/modified MDX/Markdown file, frontmatter-driven (see plan.ts
 *     `planDirectoryIngest`). Mutually exclusive with a non-default
 *     `changelog-path`.
 *
 * Env (set by action.yml):
 *   RELEASES_API_TOKEN, RELEASES_API_URL, RELEASES_SOURCE, RELEASES_ORG?,
 *   CHANGELOG_PATH, CHANGELOG_GLOB, BEFORE_SHA, URL_TEMPLATE,
 *   GENERATE_CONTENT, WORKING_DIRECTORY
 */
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AuthError,
  ApiError,
  idsForUrls,
  isSourceId,
  listSourceReleases,
  postGenerateContent,
  postReleaseBatch,
  requireApiToken,
  type FetchLike,
} from "./client";
import { gitDiffNameStatus, gitShowFile, isMissingOrZeroSha } from "./git";
import {
  isUnparsableChangelog,
  planChangelogIngest,
  planDirectoryIngest,
  toBatchBody,
  type DirectoryFileInput,
  type PlannedRelease,
} from "./plan";

const DEFAULT_CHANGELOG_PATH = "CHANGELOG.md";

export type PublishEnv = {
  RELEASES_API_TOKEN?: string;
  RELEASES_API_URL?: string;
  RELEASES_SOURCE?: string;
  RELEASES_ORG?: string;
  CHANGELOG_PATH?: string;
  CHANGELOG_GLOB?: string;
  BEFORE_SHA?: string;
  URL_TEMPLATE?: string;
  GENERATE_CONTENT?: string;
  WORKING_DIRECTORY?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_REF_NAME?: string;
  GITHUB_OUTPUT?: string;
};

export type PublishResult = {
  added: string[];
  modified: string[];
  deleted: number;
  inserted: number;
  skipped: boolean;
};

function defaultUrlTemplate(env: PublishEnv, changelogPath: string): string {
  const repo = env.GITHUB_REPOSITORY?.trim();
  const ref = env.GITHUB_REF_NAME?.trim() || "main";
  if (repo) return `https://github.com/${repo}/blob/${ref}/${changelogPath}#{key}`;
  throw new Error("url-template is required when GITHUB_REPOSITORY is unset.");
}

/** Directory-mode fallback: the GitHub blob URL of the file itself (per-file `{path}`). */
function defaultDirectoryUrlTemplate(env: PublishEnv): string {
  const repo = env.GITHUB_REPOSITORY?.trim();
  const ref = env.GITHUB_REF_NAME?.trim() || "main";
  if (repo) return `https://github.com/${repo}/blob/${ref}/{path}`;
  throw new Error("url-template is required when GITHUB_REPOSITORY is unset.");
}

function writeOutput(file: string | undefined, name: string, value: string): void {
  if (!file) return;
  appendFileSync(file, `${name}=${value}\n`);
}

/**
 * Gathers directory-mode changed files. On first push / a new branch
 * (`before` missing or all-zero) every file matching the glob is treated as
 * added — mirroring the single-file mode's behavior of publishing
 * everything when there is no previous snapshot to diff against.
 */
async function gatherDirectoryFiles(
  env: PublishEnv,
  workdir: string | undefined,
  glob: string,
): Promise<DirectoryFileInput[]> {
  const cwd = workdir ? resolve(workdir) : process.cwd();
  const bunGlob = new Bun.Glob(glob);
  const files: DirectoryFileInput[] = [];

  const entries = gitDiffNameStatus(env.BEFORE_SHA, workdir);
  if (entries === null) {
    if (!isMissingOrZeroSha(env.BEFORE_SHA)) {
      console.warn(
        `git diff against ${env.BEFORE_SHA} failed (shallow clone or rewritten history?); publishing every file matching ${glob}.`,
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

type Plan = {
  added: string[];
  modified: string[];
  releases: PlannedRelease[];
  deletedCount: number;
  deletedPaths: string[];
};

async function computeSingleFilePlan(env: PublishEnv, workdir: string | undefined): Promise<Plan> {
  const changelogPath = env.CHANGELOG_PATH?.trim() || DEFAULT_CHANGELOG_PATH;
  const urlTemplate = env.URL_TEMPLATE?.trim() || defaultUrlTemplate(env, changelogPath);
  const filePath = workdir ? resolve(workdir, changelogPath) : resolve(changelogPath);
  const beforeMd = gitShowFile(env.BEFORE_SHA, changelogPath, workdir);
  const afterMd = readFileSync(filePath, "utf8");

  if (afterMd !== beforeMd && isUnparsableChangelog(afterMd)) {
    throw new Error(
      `${changelogPath} changed but no versioned or date-sectioned ## headings were found.`,
    );
  }

  const plan = planChangelogIngest(beforeMd, afterMd, { urlTemplate, changelogPath });
  console.log(`format=${plan.format} added=${plan.added.length} modified=${plan.modified.length}`);
  return {
    added: plan.added,
    modified: plan.modified,
    releases: plan.releases,
    deletedCount: 0,
    deletedPaths: [],
  };
}

async function computeDirectoryPlan(env: PublishEnv, workdir: string | undefined): Promise<Plan> {
  const glob = env.CHANGELOG_GLOB?.trim();
  if (!glob) throw new Error("changelog-glob is required in directory mode.");
  const urlTemplate = env.URL_TEMPLATE?.trim() || defaultDirectoryUrlTemplate(env);

  const files = await gatherDirectoryFiles(env, workdir, glob);
  const plan = planDirectoryIngest(files, { urlTemplate, glob });
  if (plan.deleted.length > 0) {
    console.log(`deleted (not removed from the index): ${plan.deleted.join(", ")}`);
  }
  return {
    added: plan.added,
    modified: plan.modified,
    releases: plan.releases,
    deletedCount: plan.deleted.length,
    deletedPaths: plan.deleted,
  };
}

export async function publishChangelog(
  env: PublishEnv,
  fetchImpl: FetchLike = fetch,
): Promise<PublishResult> {
  const token = requireApiToken(env.RELEASES_API_TOKEN);
  const source = env.RELEASES_SOURCE?.trim();
  if (!source) {
    throw new Error("source is required (src_… id, or a source slug with org).");
  }
  const org = env.RELEASES_ORG?.trim() || undefined;
  const workdir = env.WORKING_DIRECTORY?.trim() || undefined;
  const apiUrl = (env.RELEASES_API_URL?.trim() || "https://api.releases.sh").replace(/\/$/, "");
  const generateContent = (env.GENERATE_CONTENT ?? "true").toLowerCase() !== "false";

  const glob = env.CHANGELOG_GLOB?.trim() || undefined;
  const changelogPathRaw = env.CHANGELOG_PATH?.trim() || DEFAULT_CHANGELOG_PATH;
  if (glob && changelogPathRaw !== DEFAULT_CHANGELOG_PATH) {
    throw new Error(
      "changelog-glob cannot be combined with a non-default changelog-path. Set one or the other.",
    );
  }

  const plan = glob
    ? await computeDirectoryPlan(env, workdir)
    : await computeSingleFilePlan(env, workdir);

  if (plan.releases.length === 0 && plan.deletedCount === 0) {
    console.log("No changed changelog entries; nothing to publish.");
    writeOutput(env.GITHUB_OUTPUT, "added", "0");
    writeOutput(env.GITHUB_OUTPUT, "modified", "0");
    writeOutput(env.GITHUB_OUTPUT, "deleted", "0");
    writeOutput(env.GITHUB_OUTPUT, "inserted", "0");
    return { added: [], modified: [], deleted: 0, inserted: 0, skipped: true };
  }

  let inserted = 0;
  if (plan.releases.length > 0) {
    const batch = await postReleaseBatch(fetchImpl, {
      apiUrl,
      token,
      source,
      org,
      releases: toBatchBody(plan.releases),
    });
    inserted = batch.inserted;
    console.log(
      `batch: inserted=${batch.inserted} total=${batch.total} added=${plan.added.length} modified=${plan.modified.length} deleted=${plan.deletedCount}`,
    );

    if (
      generateContent &&
      isSourceId(source) &&
      (plan.added.length > 0 || plan.modified.length > 0)
    ) {
      const listed = await listSourceReleases(fetchImpl, { apiUrl, token, source, org });
      const addedKeys = new Set(plan.added);
      const modifiedKeys = new Set(plan.modified);
      const addedUrls = plan.releases.filter((r) => addedKeys.has(r.key)).map((r) => r.url);
      const modifiedUrls = plan.releases.filter((r) => modifiedKeys.has(r.key)).map((r) => r.url);
      const addedIds = idsForUrls(listed, addedUrls);
      const modifiedIds = idsForUrls(listed, modifiedUrls);

      if (addedIds.length) {
        const result = await postGenerateContent(fetchImpl, {
          apiUrl,
          token,
          sourceId: source,
          releaseIds: addedIds,
          regenerate: false,
        });
        console.log("generate-content added:", result);
      }
      if (modifiedIds.length) {
        const result = await postGenerateContent(fetchImpl, {
          apiUrl,
          token,
          sourceId: source,
          releaseIds: modifiedIds,
          regenerate: true,
        });
        console.log("generate-content modified:", result);
      }
    }
  }

  writeOutput(env.GITHUB_OUTPUT, "added", String(plan.added.length));
  writeOutput(env.GITHUB_OUTPUT, "modified", String(plan.modified.length));
  writeOutput(env.GITHUB_OUTPUT, "deleted", String(plan.deletedCount));
  writeOutput(env.GITHUB_OUTPUT, "inserted", String(inserted));
  return {
    added: plan.added,
    modified: plan.modified,
    deleted: plan.deletedCount,
    inserted,
    skipped: false,
  };
}

if (import.meta.main) {
  try {
    await publishChangelog(process.env as PublishEnv);
  } catch (err) {
    if (err instanceof AuthError || err instanceof ApiError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
