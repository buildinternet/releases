/**
 * Worker-safe planner for GitHub CHANGELOG discovery.
 *
 * Returns the set of CHANGELOG paths the adapter would fetch for a source —
 * root, package.json#workspaces expansion, override entries — without
 * performing the body fetches or any DB writes. The probe endpoint
 * (`POST /v1/sources/:id/changelogs:probe`) wraps this; the Node-flavored
 * `fetchChangelogFiles` in `./github.ts` calls it as the planning half.
 *
 * No Node-only imports (no logger, no config) so this can run inside a
 * Cloudflare Worker. Caller passes `apiHeaders` / `rawHeaders` (with
 * `Authorization: Bearer <token>` already populated).
 */

import type { Source } from "@buildinternet/releases-core/schema";

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

/**
 * Origin tag for a planned CHANGELOG path:
 *
 * - `root`: the repo-root CHANGELOG file picked by directory listing.
 * - `workspace`: per-package CHANGELOG resolved from any workspace
 *   declaration we know how to read — `package.json#workspaces` (npm,
 *   yarn, bun) and `pnpm-workspace.yaml`. Adding new formats (Lerna,
 *   Rush, …) keeps the same origin tag; consumers don't care which
 *   file produced it.
 * - `override`: entry in `source.metadata.changelogPaths`, an explicit
 *   list that bypasses workspace expansion entirely.
 */
export type ChangelogPathOrigin = "root" | "workspace" | "override";

export interface DiscoveredChangelogPath {
  path: string;
  origin: ChangelogPathOrigin;
  /**
   * True if a directory listing confirmed the file exists on HEAD. Override
   * entries are confirmed via a parent-directory listing; advisory pnpm
   * candidates report `exists` based on whether a CHANGELOG.md sits in the
   * resolved package dir.
   */
  exists: boolean;
}

interface GitHubContentEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

interface PackageJsonShape {
  workspaces?: string[] | { packages?: string[] };
}

export function parseOwnerRepo(url: string): { owner: string; repo: string } | null {
  // Anchor on the github.com hostname so values like
  // `https://notgithub.com/foo/bar` don't slip through and route the probe
  // (or any caller) at the wrong repo.
  const match = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

/**
 * Parse the `workspaces` field out of a package.json, tolerating both the
 * array form and the `{ packages: [...] }` form used by some monorepos.
 * Returns an empty array if the field is missing or malformed.
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
  if (Array.isArray(ws.packages))
    return ws.packages.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Parse `packages:` entries out of a `pnpm-workspace.yaml`. Light regex
 * parse — pnpm's workspace file is a flat list with a predictable shape, so
 * pulling in a YAML dependency for this would be overkill.
 */
export function parsePnpmWorkspaces(yamlText: string): string[] {
  const lines = yamlText.split(/\r?\n/);
  const out: string[] = [];
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line) continue;
    if (/^packages\s*:/i.test(line.trim())) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/);
      if (m) {
        out.push(m[1]);
        continue;
      }
      // Top-level non-list line ends the packages block.
      if (/^[A-Za-z]/.test(line)) inPackages = false;
    }
  }
  return out;
}

/** Pick the first matching changelog filename from a directory listing. */
export function pickChangelogInDir(entries: GitHubContentEntry[]): string | null {
  const files = new Set(entries.filter((e) => e.type === "file").map((e) => e.name));
  return CHANGELOG_FILENAMES.find((name) => files.has(name)) ?? null;
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
  if (cache.map.has(dirPath)) return cache.map.get(dirPath) ?? null;
  try {
    const url = dirPath
      ? `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}`
      : `https://api.github.com/repos/${owner}/${repo}/contents/`;
    const res = await fetch(url, { headers: apiHeaders });
    if (!res.ok) {
      cache.map.set(dirPath, null);
      return null;
    }
    const entries = (await res.json()) as GitHubContentEntry[];
    cache.map.set(dirPath, entries);
    return entries;
  } catch {
    cache.map.set(dirPath, null);
    return null;
  }
}

async function readRawFile(
  owner: string,
  repo: string,
  path: string,
  rawHeaders: Record<string, string>,
): Promise<string | null> {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path}`, {
      headers: rawHeaders,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function readOverridePaths(source: Source): string[] | null {
  if (!source.metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.metadata);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const cp = (parsed as Record<string, unknown>).changelogPaths;
  if (!Array.isArray(cp)) return null;
  const list = cp.filter((x): x is string => typeof x === "string");
  return list.length > 0 ? list : null;
}

interface ExpandCtx {
  owner: string;
  repo: string;
  apiHeaders: Record<string, string>;
  cache: ListingCache;
}

/**
 * Resolve a single workspace glob to the directory paths it covers. Only the
 * shapes pnpm/npm workspaces commonly emit are handled — `dir/*` (one level)
 * and bare `dir/path` (literal). Negations, `**`, and arbitrary midpath
 * wildcards are ignored: workspaces files in the wild rarely use them, and a
 * full glob engine isn't worth the worker bundle weight.
 */
async function expandWorkspaceGlob(glob: string, ctx: ExpandCtx): Promise<string[]> {
  const trimmed = glob.replace(/\/$/, "");
  if (!trimmed || trimmed.startsWith("!") || trimmed.includes("**")) return [];
  if (trimmed.endsWith("/*")) {
    const parent = trimmed.slice(0, -2);
    if (!parent || parent.includes("*")) return [];
    const entries = await listContents(ctx.owner, ctx.repo, parent, ctx.apiHeaders, ctx.cache);
    if (!entries) return [];
    return entries.filter((e) => e.type === "dir").map((e) => `${parent}/${e.name}`);
  }
  if (!trimmed.includes("*")) return [trimmed];
  return [];
}

async function expandGlobs(globs: string[], ctx: ExpandCtx): Promise<string[]> {
  const dirs: string[] = [];
  for (const glob of globs) {
    // oxlint-disable-next-line no-await-in-loop -- GitHub REST API rate limit; globs resolved sequentially
    const resolved = await expandWorkspaceGlob(glob, ctx);
    dirs.push(...resolved);
  }
  return dirs;
}

function normalizeOverridePath(entry: string): { path: string; dir: string; filename: string } {
  const path = entry.replace(/^\.?\//, "");
  const lastSlash = path.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : path.slice(0, lastSlash);
  const filename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  return { path, dir, filename };
}

/**
 * Plan the set of CHANGELOG paths the adapter would fetch for `source`,
 * without performing the body fetches.
 *
 * Always includes the repo-root CHANGELOG when present. With an override
 * set, returns root + override entries (existence resolved via parent-dir
 * listings). Without an override, expands every workspace declaration the
 * planner knows how to read — `package.json#workspaces` (npm, yarn, bun)
 * and `pnpm-workspace.yaml` — and reports each per-package CHANGELOG with
 * `origin: "workspace"`.
 *
 * Returns `null` when the source URL doesn't parse as a GitHub coordinate.
 */
export async function discoverChangelogPaths(
  source: Source,
  headers: { apiHeaders: Record<string, string>; rawHeaders: Record<string, string> },
): Promise<DiscoveredChangelogPath[] | null> {
  const parsed = parseOwnerRepo(source.url);
  if (!parsed) return null;
  const { owner, repo } = parsed;
  const { apiHeaders, rawHeaders } = headers;
  const cache: ListingCache = { map: new Map() };
  const ctx = { owner, repo, apiHeaders, cache };

  const out: DiscoveredChangelogPath[] = [];
  const seen = new Set<string>();
  const push = (path: string, origin: ChangelogPathOrigin, exists: boolean) => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ path, origin, exists });
  };

  const rootListing = await listContents(owner, repo, "", apiHeaders, cache);
  if (rootListing) {
    const rootFilename = pickChangelogInDir(rootListing);
    if (rootFilename) push(rootFilename, "root", true);
  }

  const override = readOverridePaths(source);
  if (override) {
    for (const entry of override) {
      const { path, dir, filename } = normalizeOverridePath(entry);
      let dirEntries: GitHubContentEntry[] | null;
      if (dir) {
        // oxlint-disable-next-line no-await-in-loop -- GitHub REST API rate limit; iterate override paths sequentially
        dirEntries = await listContents(owner, repo, dir, apiHeaders, cache);
      } else {
        dirEntries = rootListing;
      }
      const exists = !!dirEntries?.some((e) => e.type === "file" && e.name === filename);
      push(path, "override", exists);
    }
    return out;
  }

  if (!rootListing) return out;

  // Resolve every workspace declaration we recognize. Adding a new format
  // (Lerna, Rush, …) is one entry in this list — the rest of the function
  // doesn't care which file the globs came from.
  const workspaceGlobs = await collectWorkspaceGlobs(rootListing, owner, repo, rawHeaders);
  const packageDirs = await expandGlobs(workspaceGlobs, ctx);
  for (const dir of packageDirs) {
    // oxlint-disable-next-line no-await-in-loop -- GitHub REST API rate limit; package dirs scanned sequentially
    const dirEntries = await listContents(owner, repo, dir, apiHeaders, cache);
    if (!dirEntries) continue;
    const filename = pickChangelogInDir(dirEntries);
    if (!filename) continue;
    push(`${dir}/${filename}`, "workspace", true);
  }

  return out;
}

/**
 * Read every workspace declaration present in the repo root and merge them
 * into a single glob list. Unknown / malformed files contribute nothing.
 */
async function collectWorkspaceGlobs(
  rootListing: GitHubContentEntry[],
  owner: string,
  repo: string,
  rawHeaders: Record<string, string>,
): Promise<string[]> {
  const rootFiles = new Set(rootListing.filter((e) => e.type === "file").map((e) => e.name));
  const globs: string[] = [];

  if (rootFiles.has("package.json")) {
    const pkgText = await readRawFile(owner, repo, "package.json", rawHeaders);
    if (pkgText) globs.push(...parseWorkspaces(pkgText));
  }
  if (rootFiles.has("pnpm-workspace.yaml")) {
    const yaml = await readRawFile(owner, repo, "pnpm-workspace.yaml", rawHeaders);
    if (yaml) globs.push(...parsePnpmWorkspaces(yaml));
  }

  return globs;
}

/**
 * Build the `apiHeaders` / `rawHeaders` pair the planner expects from a raw
 * GitHub token. Convenience for callers that have a token in hand and don't
 * already build headers — the worker route handler does, but Node callers
 * (CLI / agent) lean on this.
 */
export function buildGitHubHeaders(
  token?: string | null,
  userAgent = "releases-bot",
): {
  apiHeaders: Record<string, string>;
  rawHeaders: Record<string, string>;
} {
  const apiHeaders: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": userAgent,
  };
  if (token) apiHeaders.Authorization = `Bearer ${token}`;
  const rawHeaders: Record<string, string> = { "User-Agent": userAgent };
  if (token) rawHeaders.Authorization = `Bearer ${token}`;
  return { apiHeaders, rawHeaders };
}
