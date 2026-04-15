import type { Source } from "@releases/core/schema";
import type { Adapter, RawRelease, FetchOptions, FetchResult } from "@releases/adapters/types";
import { config } from "../lib/config.js";
import { AdapterError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { sha256Hex } from "@releases/core/hash";

function parseOwnerRepo(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) {
    throw new AdapterError("github", `Cannot parse owner/repo from URL: ${url}`);
  }
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

export const CHANGELOG_FILENAMES = [
  "CHANGELOG.md",
  "CHANGELOG.rst",
  "CHANGELOG.txt",
  "CHANGELOG",
  "CHANGES.md",
  "CHANGES.rst",
  "HISTORY.md",
  "RELEASES.md",
  "NEWS.md",
];

export const CHANGELOG_MAX_BYTES = 1024 * 1024; // 1MB
export const CHANGELOG_MAX_FILES = 20;

export interface FetchedChangelogFile {
  path: string;
  filename: string;
  url: string;
  rawUrl: string;
  content: string;
  contentHash: string;
  bytes: number;
  /** True when content was sliced to fit within CHANGELOG_MAX_BYTES. */
  truncated: boolean;
}

interface GitHubContentEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

interface PackageJsonShape {
  workspaces?: string[] | { packages?: string[] };
}

/**
 * Parse the `workspaces` field out of a package.json, tolerating both the
 * array form and the `{ packages: [...] }` form used by some monorepos.
 * Returns an empty array if the field is missing or malformed. This is the
 * authoritative signal for phase 1 monorepo discovery — pnpm-only repos
 * (pnpm-workspace.yaml without a package.json workspaces field) fall back
 * to the `source.metadata.changelogPaths` override.
 */
export function parseWorkspaces(pkgJsonText: string): string[] {
  let parsed: PackageJsonShape;
  try {
    parsed = JSON.parse(pkgJsonText);
  } catch {
    return [];
  }
  const ws = parsed.workspaces;
  if (!ws) return [];
  if (Array.isArray(ws)) return ws.filter((x): x is string => typeof x === "string");
  if (Array.isArray(ws.packages)) return ws.packages.filter((x): x is string => typeof x === "string");
  return [];
}

/** Pick the first matching changelog filename from a directory listing. */
export function pickChangelogInDir(entries: GitHubContentEntry[]): string | null {
  const files = new Set(entries.filter((e) => e.type === "file").map((e) => e.name));
  return CHANGELOG_FILENAMES.find((name) => files.has(name)) ?? null;
}

function truncateToByteCap(content: string): { content: string; bytes: number; truncated: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content).length;
  if (bytes <= CHANGELOG_MAX_BYTES) {
    return { content, bytes, truncated: false };
  }
  // Slice by codepoint until we fit within the byte cap. Binary search keeps
  // this O(log n) over content length.
  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (encoder.encode(content.slice(0, mid)).length <= CHANGELOG_MAX_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const sliced = content.slice(0, lo);
  return {
    content: sliced,
    bytes: encoder.encode(sliced).length,
    truncated: true,
  };
}

interface ListingCache {
  map: Map<string, GitHubContentEntry[] | null>;
}

async function listContents(
  owner: string,
  repo: string,
  dirPath: string,
  apiHeaders: Record<string, string>,
  cache: ListingCache,
): Promise<GitHubContentEntry[] | null> {
  const key = dirPath;
  if (cache.map.has(key)) return cache.map.get(key) ?? null;
  try {
    const url = dirPath
      ? `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}`
      : `https://api.github.com/repos/${owner}/${repo}/contents/`;
    const res = await fetch(url, { headers: apiHeaders });
    if (!res.ok) {
      cache.map.set(key, null);
      return null;
    }
    const entries = (await res.json()) as GitHubContentEntry[];
    cache.map.set(key, entries);
    return entries;
  } catch {
    cache.map.set(key, null);
    return null;
  }
}

async function fetchAndBuildFile(
  owner: string,
  repo: string,
  dirPath: string,
  filename: string,
  rawHeaders: Record<string, string>,
  sourceSlug: string,
): Promise<FetchedChangelogFile | null> {
  const fullPath = dirPath ? `${dirPath}/${filename}` : filename;
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${fullPath}`;
  let res: Response;
  try {
    res = await fetch(rawUrl, { headers: rawHeaders });
  } catch (err) {
    logger.warn(`fetchChangelogFiles(${sourceSlug}): raw fetch failed for ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!res.ok) {
    logger.warn(`fetchChangelogFiles(${sourceSlug}): raw fetch returned ${res.status} for ${fullPath}`);
    return null;
  }
  const rawContent = await res.text();
  const { content, bytes, truncated } = truncateToByteCap(rawContent);
  if (truncated) {
    logger.warn(`fetchChangelogFiles(${sourceSlug}): ${fullPath} exceeds size cap, truncated to ${bytes} bytes`);
  }
  return {
    path: fullPath,
    filename,
    url: `https://github.com/${owner}/${repo}/blob/HEAD/${fullPath}`,
    rawUrl,
    content,
    contentHash: sha256Hex(content),
    bytes,
    truncated,
  };
}

/**
 * Fetch all CHANGELOG files for a GitHub source — root plus any per-package
 * files discovered via `package.json#workspaces`. Capped at CHANGELOG_MAX_FILES
 * per source. The `source.metadata.changelogPaths: string[]` override, when
 * set, bypasses discovery entirely and uses the provided paths verbatim.
 * Each fetched file is capped at 1MB; content exceeding the cap is truncated
 * and flagged via `truncated: true`.
 */
export async function fetchChangelogFiles(source: Source): Promise<FetchedChangelogFile[]> {
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseOwnerRepo(source.url));
  } catch (err) {
    logger.warn(`fetchChangelogFiles: cannot parse owner/repo for ${source.slug}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const token = config.githubToken();
  const apiHeaders: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) apiHeaders.Authorization = `Bearer ${token}`;
  const rawHeaders: Record<string, string> = {};
  if (token) rawHeaders.Authorization = `Bearer ${token}`;

  const cache: ListingCache = { map: new Map() };
  let requestCount = 0;

  // Override path: skip discovery entirely.
  const meta = parseMetadata(source.metadata);
  const override = Array.isArray(meta?.changelogPaths)
    ? (meta.changelogPaths as unknown[]).filter((x): x is string => typeof x === "string")
    : null;

  if (override && override.length > 0) {
    // Interpret each override entry as a full file path (relative to repo
    // root). We split it into `dir` and `filename` and fetch directly.
    // Always include root as well for back-compat.
    const files: FetchedChangelogFile[] = [];
    const rootListing = await listContents(owner, repo, "", apiHeaders, cache);
    requestCount++;
    if (rootListing) {
      const rootFilename = pickChangelogInDir(rootListing);
      if (rootFilename) {
        const f = await fetchAndBuildFile(owner, repo, "", rootFilename, rawHeaders, source.slug);
        requestCount++;
        if (f) files.push(f);
      }
    }
    const seen = new Set(files.map((f) => f.path));
    for (const entry of override) {
      if (files.length >= CHANGELOG_MAX_FILES) {
        logger.info(`fetchChangelogFiles(${source.slug}): hit CHANGELOG_MAX_FILES cap, skipping remaining overrides`);
        break;
      }
      const normalized = entry.replace(/^\.?\//, "");
      if (seen.has(normalized)) continue;
      const lastSlash = normalized.lastIndexOf("/");
      const dir = lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
      const filename = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
      const f = await fetchAndBuildFile(owner, repo, dir, filename, rawHeaders, source.slug);
      requestCount++;
      if (f) {
        files.push(f);
        seen.add(f.path);
      }
    }
    logger.info(`fetchChangelogFiles(${source.slug}): ${files.length} files, ${requestCount} requests (override)`);
    return files;
  }

  // Discovery path: root listing → pick root CHANGELOG → read root
  // package.json → parse workspaces → resolve globs → scan each package dir.
  const rootListing = await listContents(owner, repo, "", apiHeaders, cache);
  requestCount++;
  if (!rootListing) {
    logger.info(`fetchChangelogFiles(${source.slug}): 0 files, ${requestCount} requests`);
    return [];
  }

  const files: FetchedChangelogFile[] = [];
  const rootFilename = pickChangelogInDir(rootListing);
  if (rootFilename) {
    const f = await fetchAndBuildFile(owner, repo, "", rootFilename, rawHeaders, source.slug);
    requestCount++;
    if (f) files.push(f);
  }

  // Look for a root package.json to parse workspaces. We only trigger
  // monorepo discovery when this file exists — pnpm-only repos without a
  // package.json workspaces field fall back to the `changelogPaths` override.
  const hasRootPkgJson = rootListing.some((e) => e.type === "file" && e.name === "package.json");
  if (hasRootPkgJson) {
    const pkgJsonUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/package.json`;
    let pkgText: string | null = null;
    try {
      const res = await fetch(pkgJsonUrl, { headers: rawHeaders });
      requestCount++;
      if (res.ok) pkgText = await res.text();
    } catch {
      pkgText = null;
    }
    const globs = pkgText ? parseWorkspaces(pkgText) : [];
    const packageDirs: string[] = [];
    for (const glob of globs) {
      if (packageDirs.length + files.length >= CHANGELOG_MAX_FILES) break;
      const trimmed = glob.replace(/\/$/, "");
      if (trimmed.startsWith("!") || trimmed.includes("**")) continue;
      if (trimmed.endsWith("/*")) {
        const parent = trimmed.slice(0, -2);
        if (!parent || parent.includes("*")) continue;
        const parentEntries = await listContents(owner, repo, parent, apiHeaders, cache);
        requestCount++;
        if (!parentEntries) continue;
        for (const entry of parentEntries) {
          if (entry.type !== "dir") continue;
          packageDirs.push(`${parent}/${entry.name}`);
          if (packageDirs.length + files.length >= CHANGELOG_MAX_FILES) break;
        }
      } else if (!trimmed.includes("*")) {
        packageDirs.push(trimmed);
      }
    }

    for (const dir of packageDirs) {
      if (files.length >= CHANGELOG_MAX_FILES) {
        logger.info(`fetchChangelogFiles(${source.slug}): hit CHANGELOG_MAX_FILES cap`);
        break;
      }
      const dirEntries = await listContents(owner, repo, dir, apiHeaders, cache);
      requestCount++;
      if (!dirEntries) continue;
      const filename = pickChangelogInDir(dirEntries);
      if (!filename) continue;
      const f = await fetchAndBuildFile(owner, repo, dir, filename, rawHeaders, source.slug);
      requestCount++;
      if (f) files.push(f);
    }
  }

  logger.info(`fetchChangelogFiles(${source.slug}): ${files.length} files, ${requestCount} requests`);
  return files;
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Back-compat thin wrapper around {@link fetchChangelogFiles}. Returns the
 * first (root) file if one exists, or null. Callers that want the full set
 * should use {@link fetchChangelogFiles} directly.
 */
export async function fetchChangelogFile(source: Source): Promise<FetchedChangelogFile | null> {
  const files = await fetchChangelogFiles(source);
  return files[0] ?? null;
}

export async function detectChangelogUrl(source: Source): Promise<string | null> {
  const { owner, repo } = parseOwnerRepo(source.url);
  const token = config.githubToken();

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  for (const filename of CHANGELOG_FILENAMES) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${filename}`,
        { method: "HEAD", headers },
      );
      if (res.ok) {
        return `https://github.com/${owner}/${repo}/blob/HEAD/${filename}`;
      }
    } catch {
      // Skip network errors for individual file checks
    }
  }

  return null;
}

export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
}

// Re-fetch protection: The UNIQUE constraints on releases (source_id, url)
// and (source_id, content_hash) already handle dedup at the DB level.
// A lightweight optimization to skip fetching all pages when the latest
// release hasn't changed could be added here in the future.
export const github: Adapter = {
  async fetch(source: Source, options?: FetchOptions): Promise<FetchResult> {
    const { owner, repo } = parseOwnerRepo(source.url);
    const token = config.githubToken();
    const since = options?.since;
    const maxEntries = options?.maxEntries;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const releases: RawRelease[] = [];
    let url: string | null =
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;
    let hitDateCutoff = false;

    while (url && !hitDateCutoff) {
      const res: Response = await fetch(url, { headers });

      if (res.status === 429) {
        logger.warn(`GitHub rate limit hit for ${owner}/${repo}. Returning ${releases.length} releases fetched so far.`);
        break;
      }

      if (!res.ok) {
        throw new AdapterError(
          "github",
          `GitHub API returned ${res.status} for ${owner}/${repo}: ${await res.text()}`,
        );
      }

      const data: GitHubRelease[] = await res.json();

      for (const rel of data) {
        const publishedAt = rel.published_at ? new Date(rel.published_at) : undefined;

        // Stop if we've gone past the date cutoff (GitHub returns newest first)
        if (since && publishedAt && publishedAt < since) {
          hitDateCutoff = true;
          break;
        }

        releases.push({
          version: rel.tag_name,
          title: rel.name || rel.tag_name,
          content: rel.body || "",
          url: rel.html_url,
          publishedAt,
        });

        if (maxEntries && releases.length >= maxEntries) {
          return { releases };
        }
      }

      url = hitDateCutoff ? null : parseNextLink(res.headers.get("link"));
    }

    return { releases };
  },
};
