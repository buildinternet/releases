import type { Source } from "../db/schema.js";
import type { Adapter, RawRelease, FetchOptions, FetchResult } from "./types.js";
import { config } from "../lib/config.js";
import { AdapterError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { sha256Hex } from "../lib/hash.js";

function parseOwnerRepo(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) {
    throw new AdapterError("github", `Cannot parse owner/repo from URL: ${url}`);
  }
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

const CHANGELOG_FILENAMES = [
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

const CHANGELOG_MAX_BYTES = 1024 * 1024; // 1MB

export interface FetchedChangelogFile {
  path: string;
  filename: string;
  url: string;
  rawUrl: string;
  content: string;
  contentHash: string;
  bytes: number;
}

interface GitHubContentEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

/**
 * Fetch the canonical CHANGELOG file from a GitHub source's repository.
 *
 * Lists the repo root via the GitHub Contents API in one call, picks the
 * first matching filename, then GETs it from raw.githubusercontent.com.
 * Caps content at 1MB and returns null on 404, network errors, or oversized
 * files. Never throws.
 */
export async function fetchChangelogFile(source: Source): Promise<FetchedChangelogFile | null> {
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseOwnerRepo(source.url));
  } catch (err) {
    logger.warn(`fetchChangelogFile: cannot parse owner/repo for ${source.slug}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const token = config.githubToken();
  const apiHeaders: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) apiHeaders.Authorization = `Bearer ${token}`;

  let entries: GitHubContentEntry[];
  try {
    const listing = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/`,
      { headers: apiHeaders },
    );
    if (!listing.ok) {
      logger.warn(`fetchChangelogFile(${source.slug}): root listing returned ${listing.status}`);
      return null;
    }
    entries = (await listing.json()) as GitHubContentEntry[];
  } catch (err) {
    logger.warn(`fetchChangelogFile(${source.slug}): root listing failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const rootFiles = new Set(entries.filter((e) => e.type === "file").map((e) => e.name));
  const filename = CHANGELOG_FILENAMES.find((name) => rootFiles.has(name));
  if (!filename) return null;

  const rawHeaders: Record<string, string> = {};
  if (token) rawHeaders.Authorization = `Bearer ${token}`;

  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${filename}`;
  let res: Response;
  try {
    res = await fetch(rawUrl, { headers: rawHeaders });
  } catch (err) {
    logger.warn(`fetchChangelogFile(${source.slug}): raw fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!res.ok) {
    logger.warn(`fetchChangelogFile(${source.slug}): raw fetch returned ${res.status} for ${filename}`);
    return null;
  }
  const content = await res.text();
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > CHANGELOG_MAX_BYTES) {
    logger.warn(`fetchChangelogFile(${source.slug}): ${filename} exceeds size cap (${bytes} bytes), skipping`);
    return null;
  }
  return {
    path: filename,
    filename,
    url: `https://github.com/${owner}/${repo}/blob/HEAD/${filename}`,
    rawUrl,
    content,
    contentHash: sha256Hex(content),
    bytes,
  };
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
