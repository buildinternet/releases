#!/usr/bin/env bun
/**
 * Push-changed changelog sections into Releases Index via
 * POST /v1/sources/…/releases/batch (`upsert-content`).
 *
 * Env (set by action.yml):
 *   RELEASES_API_TOKEN, RELEASES_API_URL, RELEASES_SOURCE, RELEASES_ORG?,
 *   CHANGELOG_PATH, BEFORE_SHA, URL_TEMPLATE, GENERATE_CONTENT,
 *   WORKING_DIRECTORY
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
import { gitShowFile } from "./git";
import { isUnparsableChangelog, planChangelogIngest, toBatchBody } from "./plan";

export type PublishEnv = {
  RELEASES_API_TOKEN?: string;
  RELEASES_API_URL?: string;
  RELEASES_SOURCE?: string;
  RELEASES_ORG?: string;
  CHANGELOG_PATH?: string;
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
  inserted: number;
  skipped: boolean;
};

function defaultUrlTemplate(env: PublishEnv, changelogPath: string): string {
  const repo = env.GITHUB_REPOSITORY?.trim();
  const ref = env.GITHUB_REF_NAME?.trim() || "main";
  if (repo) return `https://github.com/${repo}/blob/${ref}/${changelogPath}#{key}`;
  throw new Error("url-template is required when GITHUB_REPOSITORY is unset.");
}

function writeOutput(file: string | undefined, name: string, value: string): void {
  if (!file) return;
  appendFileSync(file, `${name}=${value}\n`);
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
  const changelogPath = env.CHANGELOG_PATH?.trim() || "CHANGELOG.md";
  const workdir = env.WORKING_DIRECTORY?.trim() || undefined;
  const apiUrl = (env.RELEASES_API_URL?.trim() || "https://api.releases.sh").replace(/\/$/, "");
  const urlTemplate = env.URL_TEMPLATE?.trim() || defaultUrlTemplate(env, changelogPath);
  const generateContent = (env.GENERATE_CONTENT ?? "true").toLowerCase() !== "false";

  const filePath = workdir ? resolve(workdir, changelogPath) : resolve(changelogPath);
  const beforeMd = gitShowFile(env.BEFORE_SHA, changelogPath, workdir);
  const afterMd = readFileSync(filePath, "utf8");

  if (afterMd !== beforeMd && isUnparsableChangelog(afterMd)) {
    throw new Error(
      `${changelogPath} changed but no versioned or date-sectioned ## headings were found.`,
    );
  }

  const plan = planChangelogIngest(beforeMd, afterMd, { urlTemplate, changelogPath });
  if (plan.releases.length === 0) {
    console.log("No changed changelog sections; nothing to publish.");
    writeOutput(env.GITHUB_OUTPUT, "added", "0");
    writeOutput(env.GITHUB_OUTPUT, "modified", "0");
    writeOutput(env.GITHUB_OUTPUT, "inserted", "0");
    return { added: [], modified: [], inserted: 0, skipped: true };
  }

  const batch = await postReleaseBatch(fetchImpl, {
    apiUrl,
    token,
    source,
    org,
    releases: toBatchBody(plan.releases),
  });
  console.log(
    `batch: inserted=${batch.inserted} total=${batch.total} format=${plan.format} added=${plan.added.length} modified=${plan.modified.length}`,
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

  writeOutput(env.GITHUB_OUTPUT, "added", String(plan.added.length));
  writeOutput(env.GITHUB_OUTPUT, "modified", String(plan.modified.length));
  writeOutput(env.GITHUB_OUTPUT, "inserted", String(batch.inserted));
  return {
    added: plan.added,
    modified: plan.modified,
    inserted: batch.inserted,
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
