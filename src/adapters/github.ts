import type { Source } from "../db/schema.js";
import type { Adapter, RawRelease, FetchOptions } from "./types.js";
import { config } from "../lib/config.js";
import { AdapterError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

function parseOwnerRepo(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) {
    throw new AdapterError("github", `Cannot parse owner/repo from URL: ${url}`);
  }
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

function parseNextLink(linkHeader: string | null): string | null {
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
  async fetch(source: Source, options?: FetchOptions): Promise<RawRelease[]> {
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
          return releases;
        }
      }

      url = hitDateCutoff ? null : parseNextLink(res.headers.get("link"));
    }

    return releases;
  },
};
