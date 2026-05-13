import type { Source } from "@buildinternet/releases-core/schema";
import type { Adapter, RawRelease, FetchOptions, FetchResult } from "@releases/adapters/types";
import { config } from "@releases/lib/config";
import { AdapterError } from "@releases/lib/errors";
import { logger } from "@buildinternet/releases-lib/logger";
import { logEvent } from "@releases/lib/log-event";
import { sha256Hex } from "@releases/core-internal/hash";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import {
  CHANGELOG_FILENAMES,
  buildGitHubHeaders,
  discoverChangelogPaths as discoverChangelogPathsCore,
  parseOwnerRepo as parseOwnerRepoCore,
} from "@releases/adapters/github-discovery";
import { getSourceMeta } from "@releases/adapters/source-meta";
import type {
  ChangelogPathOrigin,
  DiscoveredChangelogPath,
} from "@releases/adapters/github-discovery";

export {
  CHANGELOG_FILENAMES,
  parseWorkspaces,
  parsePnpmWorkspaces,
  pickChangelogInDir,
} from "@releases/adapters/github-discovery";
export type { ChangelogPathOrigin, DiscoveredChangelogPath };

function parseOwnerRepo(url: string): { owner: string; repo: string } {
  const parsed = parseOwnerRepoCore(url);
  if (!parsed) throw new AdapterError("github", `Cannot parse owner/repo from URL: ${url}`);
  return parsed;
}

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

function buildHeaders(): {
  apiHeaders: Record<string, string>;
  rawHeaders: Record<string, string>;
} {
  return buildGitHubHeaders(config.githubToken(), RELEASES_BOT_UA);
}

/**
 * Truncate `content` to the largest UTF-8-safe suffix that fits within
 * `CHANGELOG_MAX_BYTES`. CHANGELOGs are newest-at-top, so we keep the tail
 * (recent entries) and discard the head (historical entries).
 *
 * The binary search converges on the smallest start index whose suffix fits
 * under the cap — O(log n) over content length.
 */
export function truncateToByteCap(content: string): {
  content: string;
  bytes: number;
  truncated: boolean;
} {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content).length;
  if (bytes <= CHANGELOG_MAX_BYTES) {
    return { content, bytes, truncated: false };
  }
  // Binary-search for the smallest start index whose suffix fits the cap.
  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (encoder.encode(content.slice(mid)).length <= CHANGELOG_MAX_BYTES) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  const sliced = content.slice(lo);
  return {
    content: sliced,
    bytes: encoder.encode(sliced).length,
    truncated: true,
  };
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
    logger.warn(
      `fetchChangelogFiles(${sourceSlug}): raw fetch failed for ${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (!res.ok) {
    logger.warn(
      `fetchChangelogFiles(${sourceSlug}): raw fetch returned ${res.status} for ${fullPath}`,
    );
    return null;
  }
  const rawContent = await res.text();
  const { content, bytes, truncated } = truncateToByteCap(rawContent);
  if (truncated) {
    logger.warn(
      `fetchChangelogFiles(${sourceSlug}): ${fullPath} exceeds size cap, truncated to ${bytes} bytes`,
    );
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
 * Plan the set of CHANGELOG paths the adapter would fetch for `source`,
 * without performing the body fetches. Node-flavored wrapper around the
 * worker-safe planner in `./github-discovery.ts` — pulls the GitHub token
 * from `config.githubToken()` and uses the standard `RELEASES_BOT_UA`.
 */
export async function discoverChangelogPaths(source: Source): Promise<DiscoveredChangelogPath[]> {
  const headers = buildHeaders();
  const planned = await discoverChangelogPathsCore(source, headers);
  if (planned === null) {
    logger.warn(
      `discoverChangelogPaths: cannot parse owner/repo for ${source.slug}: ${source.url}`,
    );
    return [];
  }
  return planned;
}

/**
 * Fetch all CHANGELOG files for a GitHub source. Discovery and override
 * resolution live in {@link discoverChangelogPaths}; this function fetches
 * each planned path that exists and applies the per-source `CHANGELOG_MAX_FILES`
 * cap. Each fetched file is capped at 1MB; content exceeding the cap is
 * truncated and flagged via `truncated: true`.
 */
export async function fetchChangelogFiles(source: Source): Promise<FetchedChangelogFile[]> {
  const parsed = parseOwnerRepoCore(source.url);
  if (!parsed) {
    logger.warn(`fetchChangelogFiles: cannot parse owner/repo for ${source.slug}: ${source.url}`);
    return [];
  }
  const { owner, repo } = parsed;
  const headers = buildHeaders();

  const planned = (await discoverChangelogPathsCore(source, headers)) ?? [];
  const fetchable = planned.filter((p) => p.exists);

  const files: FetchedChangelogFile[] = [];
  // Why: log line distinguishes operator-driven overrides from auto-discovery
  // so we can spot misconfigured `metadata.changelogPaths` in cron output.
  const isOverride = planned.some((p) => p.origin === "override");
  let truncatedFetch = false;
  for (const entry of fetchable) {
    if (files.length >= CHANGELOG_MAX_FILES) {
      truncatedFetch = true;
      break;
    }
    const lastSlash = entry.path.lastIndexOf("/");
    const dir = lastSlash === -1 ? "" : entry.path.slice(0, lastSlash);
    const filename = lastSlash === -1 ? entry.path : entry.path.slice(lastSlash + 1);
    // oxlint-disable-next-line no-await-in-loop -- GitHub REST API rate limit; fetch each changelog file sequentially
    const f = await fetchAndBuildFile(owner, repo, dir, filename, headers.rawHeaders, source.slug);
    if (f) files.push(f);
  }

  if (truncatedFetch) {
    logger.info(
      `fetchChangelogFiles(${source.slug}): hit CHANGELOG_MAX_FILES cap${
        isOverride ? ", skipping remaining overrides" : ""
      }`,
    );
  }
  logger.info(
    `fetchChangelogFiles(${source.slug}): ${files.length} files${isOverride ? " (override)" : ""}`,
  );
  return files;
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
    "User-Agent": RELEASES_BOT_UA,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  for (const filename of CHANGELOG_FILENAMES) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- GitHub REST API rate limit; probe each filename sequentially until found
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
  prerelease: boolean;
}

/**
 * Returns `"deny"` if the tag should be skipped due to a deny-prefix match,
 * `"allow"` if the tag passes an allow-pattern filter, `"no-filter"` if no
 * filter is configured, or `"allow-miss"` when the tag fails the allow-pattern
 * filter.
 *
 * Precedence rule: when `tagAllowPatterns` is non-empty it takes sole control;
 * `tagDenyPrefixes` is ignored. When only `tagDenyPrefixes` is set, any
 * prefix match causes the tag to be skipped. Neither set → no filtering.
 *
 * Invalid regex patterns in `allowPatterns` are skipped (treated as
 * non-matching) rather than thrown — a malformed entry in source metadata
 * must not abort the whole fetch. Callers can pass `onInvalidPattern` to
 * surface the error (e.g. via `logEvent`); they're responsible for
 * deduping if the same source emits many tags.
 */
export function evaluateTagFilter(
  tag: string,
  denyPrefixes: string[] | undefined,
  allowPatterns: string[] | undefined,
  onInvalidPattern?: (pattern: string, err: unknown) => void,
): "no-filter" | "allow" | "deny" | "allow-miss" {
  const hasAllow = Array.isArray(allowPatterns) && allowPatterns.length > 0;
  const hasDeny = Array.isArray(denyPrefixes) && denyPrefixes.length > 0;

  if (hasAllow) {
    // Allow-patterns take sole control — deny-prefixes are ignored.
    // Each pattern is compiled and tested independently; a malformed pattern
    // is skipped (treated as non-matching) so one bad entry doesn't abort
    // the entire fetch.
    const matched = allowPatterns.some((pattern) => {
      try {
        return new RegExp(pattern).test(tag);
      } catch (err) {
        onInvalidPattern?.(pattern, err);
        return false;
      }
    });
    return matched ? "allow" : "allow-miss";
  }

  if (hasDeny) {
    const matched = denyPrefixes.some((prefix) => tag.startsWith(prefix));
    return matched ? "deny" : "no-filter";
  }

  return "no-filter";
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
    const meta = getSourceMeta(source);
    const { tagDenyPrefixes, tagAllowPatterns } = meta;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": RELEASES_BOT_UA,
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const releases: RawRelease[] = [];
    let url: string | null = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;
    let hitDateCutoff = false;

    // Dedup the invalid-pattern warning per fetch: every tag would otherwise
    // re-trigger the same compile failure and spam Workers Logs.
    const loggedBadPatterns = new Set<string>();
    const onInvalidPattern = (pattern: string, err: unknown): void => {
      if (loggedBadPatterns.has(pattern)) return;
      loggedBadPatterns.add(pattern);
      logEvent("warn", {
        component: "github-adapter",
        event: "tag-pattern-invalid",
        sourceSlug: source.slug,
        pattern,
        err: err instanceof Error ? err.message : String(err),
      });
    };

    while (url && !hitDateCutoff) {
      // oxlint-disable-next-line no-await-in-loop -- GitHub REST API pagination; next URL comes from prior response Link header
      const res: Response = await fetch(url, { headers });

      if (res.status === 429) {
        logger.warn(
          `GitHub rate limit hit for ${owner}/${repo}. Returning ${releases.length} releases fetched so far.`,
        );
        break;
      }

      if (!res.ok) {
        // oxlint-disable-next-line no-await-in-loop -- GitHub REST API pagination; reading error body from same paged response
        const errBody = await res.text();
        throw new AdapterError(
          "github",
          `GitHub API returned ${res.status} for ${owner}/${repo}: ${errBody}`,
        );
      }

      // oxlint-disable-next-line no-await-in-loop -- GitHub REST API pagination; reading JSON body from same paged response
      const data: GitHubRelease[] = await res.json();

      for (const rel of data) {
        const publishedAt = rel.published_at ? new Date(rel.published_at) : undefined;

        // Stop if we've gone past the date cutoff (GitHub returns newest first)
        if (since && publishedAt && publishedAt < since) {
          hitDateCutoff = true;
          break;
        }

        // Tag filter: runs before any release-detail fetch or DB read so that
        // noise tags are a cheap skip. allow-patterns take precedence over
        // deny-prefixes when both are configured. Invalid allow-patterns are
        // logged once per fetch (via `onInvalidPattern`) and skipped — never
        // thrown — so one bad regex can't abort ingest.
        const filterResult = evaluateTagFilter(
          rel.tag_name,
          tagDenyPrefixes,
          tagAllowPatterns,
          onInvalidPattern,
        );
        if (filterResult === "deny" || filterResult === "allow-miss") {
          logEvent("info", {
            component: "github-adapter",
            event: "tag-filtered",
            sourceSlug: source.slug,
            tag: rel.tag_name,
            reason: filterResult === "deny" ? "deny-prefix" : "allow-pattern-miss",
          });
          continue;
        }

        releases.push({
          version: rel.tag_name,
          title: rel.name || rel.tag_name,
          content: rel.body || "",
          url: rel.html_url,
          publishedAt,
          prerelease: rel.prerelease === true,
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
