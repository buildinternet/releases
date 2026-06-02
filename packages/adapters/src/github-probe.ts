/**
 * Lightweight GitHub repo probe used by the on-demand lookup endpoint to
 * decide whether a coordinate maps to a real, fetchable repo before we
 * spend time on the full ingest path. Three concerns:
 *
 *   - exists: GET /repos/{owner}/{repo} returns 200
 *   - hasReleases: at least one tag/release in /repos/{owner}/{repo}/releases
 *   - hasChangelog: CHANGELOG.md exists at the repo root
 *
 * Auth uses the worker's GITHUB_TOKEN binding when present (5000 req/h)
 * and falls back to anonymous (60 req/h) otherwise. The caller decides
 * how to react to ProbeRateLimitError / ProbeServerError — typically by
 * returning a "deferred" status to the client without writing to the
 * negative cache, so a retry shortly after has a chance of succeeding.
 */

import { RELEASES_BOT_UA } from "./user-agent.js";

export interface ProbeResult {
  exists: boolean;
  archived: boolean;
  hasReleases: boolean;
  hasChangelog: boolean;
  defaultBranch: string | null;
  // Canonical case as GitHub stores them — used by the on-demand lookup
  // path to set org `name` and source `name` regardless of the case the
  // user typed in the coordinate. Null when the repo was not found.
  ownerLogin: string | null;
  repoName: string | null;
  // GitHub stargazer count from the /repos response. Null when the repo was
  // not found or the field was absent.
  stargazersCount: number | null;
}

export class ProbeRateLimitError extends Error {
  override name = "ProbeRateLimitError";
}

export class ProbeServerError extends Error {
  override name = "ProbeServerError";
}

interface ProbeEnv {
  GITHUB_TOKEN?: string;
}

function headers(env: ProbeEnv): HeadersInit {
  const h: Record<string, string> = {
    "User-Agent": RELEASES_BOT_UA,
    Accept: "application/vnd.github+json",
  };
  if (env.GITHUB_TOKEN) h["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

async function ghFetch(env: ProbeEnv, path: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com${path}`, { headers: headers(env) });
  } catch (err) {
    // Network/timeout — surface as a transient server error so the caller
    // returns "deferred" instead of caching a permanent failure.
    throw new ProbeServerError(`GitHub network error on ${path}: ${(err as Error).message}`);
  }
  if (res.status === 429) throw new ProbeRateLimitError(`GitHub rate-limit on ${path}`);
  // GitHub returns 403 for both private/forbidden repos AND secondary rate
  // limits. Distinguish via X-RateLimit-Remaining=0 or body indicators so
  // throttles defer instead of being cached as not_found.
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      throw new ProbeRateLimitError(`GitHub rate-limit on ${path} (remaining=0)`);
    }
    // Body inspection is best-effort — clone so the original is still readable.
    const body = await res
      .clone()
      .text()
      .catch(() => "");
    if (/secondary rate limit|rate limit exceeded|abuse detection/i.test(body)) {
      throw new ProbeRateLimitError(`GitHub secondary rate-limit on ${path}`);
    }
  }
  if (res.status >= 500) throw new ProbeServerError(`GitHub ${res.status} on ${path}`);
  return res;
}

export async function probeRepo(env: ProbeEnv, owner: string, repo: string): Promise<ProbeResult> {
  const repoRes = await ghFetch(env, `/repos/${owner}/${repo}`);
  if (repoRes.status === 404 || repoRes.status === 403) {
    return {
      exists: false,
      archived: false,
      hasReleases: false,
      hasChangelog: false,
      defaultBranch: null,
      ownerLogin: null,
      repoName: null,
      stargazersCount: null,
    };
  }
  const repoBody = (await repoRes.json()) as {
    archived?: boolean;
    default_branch?: string;
    name?: string;
    owner?: { login?: string };
    stargazers_count?: number;
  };
  const ownerLogin = repoBody.owner?.login ?? null;
  const repoName = repoBody.name ?? null;

  // Skip the releases + CHANGELOG calls when the repo is archived. The
  // caller already treats archived as a not_found-equivalent, so the extra
  // GitHub round-trips waste rate-limit and risk classifying a normal
  // archived repo as "deferred" if either call hits a transient 5xx.
  if (repoBody.archived) {
    return {
      exists: true,
      archived: true,
      hasReleases: false,
      hasChangelog: false,
      defaultBranch: repoBody.default_branch ?? null,
      ownerLogin,
      repoName,
      stargazersCount: repoBody.stargazers_count ?? null,
    };
  }

  const [releasesRes, changelogRes] = await Promise.all([
    ghFetch(env, `/repos/${owner}/${repo}/releases?per_page=1`),
    ghFetch(env, `/repos/${owner}/${repo}/contents/CHANGELOG.md`),
  ]);

  const releasesBody = releasesRes.status === 200 ? ((await releasesRes.json()) as unknown[]) : [];

  return {
    exists: true,
    archived: false,
    hasReleases: Array.isArray(releasesBody) && releasesBody.length > 0,
    hasChangelog: changelogRes.status === 200,
    defaultBranch: repoBody.default_branch ?? null,
    ownerLogin,
    repoName,
    stargazersCount: repoBody.stargazers_count ?? null,
  };
}
