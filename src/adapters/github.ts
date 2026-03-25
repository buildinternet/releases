import type { Source } from "../db/schema.js";
import type { Adapter, RawRelease } from "./types.js";
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

export const github: Adapter = {
  async fetch(source: Source): Promise<RawRelease[]> {
    const { owner, repo } = parseOwnerRepo(source.url);
    const token = config.githubToken();

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const releases: RawRelease[] = [];
    let url: string | null =
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;

    while (url) {
      const response = await fetch(url, { headers });

      if (response.status === 429) {
        logger.warn(`GitHub rate limit hit for ${owner}/${repo}. Returning ${releases.length} releases fetched so far.`);
        break;
      }

      if (!response.ok) {
        throw new AdapterError(
          "github",
          `GitHub API returned ${response.status} for ${owner}/${repo}: ${await response.text()}`,
        );
      }

      const data: GitHubRelease[] = await response.json();

      for (const rel of data) {
        releases.push({
          version: rel.tag_name,
          title: rel.name || rel.tag_name,
          content: rel.body || "",
          url: rel.html_url,
          publishedAt: rel.published_at ? new Date(rel.published_at) : undefined,
        });
      }

      url = parseNextLink(response.headers.get("link"));
    }

    return releases;
  },
};
